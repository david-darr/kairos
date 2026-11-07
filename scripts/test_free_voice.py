"""Free realtime voice with a Gemini API key (core/free_voice.py): check, connect, free-tier pricing. Google's API is a
mock; nothing leaves the machine. Run: python scripts/test_free_voice.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-free-voice-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from core import free_voice, model_endpoints, realtime_usage  # noqa: E402
from services import realtime_session  # noqa: E402

KEY = "AIzaSyFAKE0123456789abcdefghijklmnopqrs"


class Google:
    """Stands in for generativelanguage.googleapis.com's model list."""

    def __init__(self, status=200, models=None, pages=False):
        self.status, self.requests, self.pages = status, [], pages
        self.models = models if models is not None else [
            {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-3.1-flash-live-preview", "supportedGenerationMethods": ["bidiGenerateContent"]},
            {"name": "models/gemini-2.5-flash-native-audio-preview", "supportedGenerationMethods": ["bidiGenerateContent"]}]
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request):
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"message": "nope"}})
        if self.pages and "pageToken" not in str(request.url):
            return httpx.Response(200, json={"models": self.models[:1], "nextPageToken": "p2"})
        return httpx.Response(200, json={"models": self.models[1:] if self.pages else self.models})


class FreeVoiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for listed in model_endpoints.list_endpoints():
            model_endpoints.delete_endpoint(listed["id"])
        self.google = Google()
        free_voice.TRANSPORT = self.google.transport

    def tearDown(self):
        free_voice.TRANSPORT = None

    async def test_a_working_key_is_checked_once_and_saved_as_a_free_realtime_connection(self):
        result = await free_voice.connect(KEY)
        self.assertTrue(result["configured"])
        self.assertEqual(result["model"], "gemini-3.1-flash-live-preview")
        request = self.google.requests[0]
        self.assertEqual(request.headers["x-goog-api-key"], KEY)
        self.assertNotIn(KEY, str(request.url))                    # the key is never part of a URL
        shown = model_endpoints.list_endpoints()
        self.assertEqual(len(shown), 1)
        self.assertEqual((shown[0]["realtime_provider"], shown[0]["free_tier"], shown[0]["kind"]), ("gemini", True, "api"))
        self.assertNotIn(KEY, json.dumps(shown))
        self.assertNotIn(KEY, Path(model_endpoints.endpoints_file()).read_text())   # sealed at rest
        self.assertNotIn(KEY, json.dumps(free_voice.status()))
        provider, model, key = model_endpoints.realtime_runtime(shown[0]["id"])
        self.assertEqual((provider, model, key), ("gemini", "gemini-3.1-flash-live-preview", KEY))
        choice = realtime_session.choices()[0]
        self.assertEqual((choice["free_tier"], choice["price_per_minute"]), (True, 0.0))

    async def test_connecting_again_replaces_the_old_free_key(self):
        await free_voice.connect(KEY)
        await free_voice.connect(KEY[:-1] + "t")
        self.assertEqual(len(model_endpoints.list_endpoints()), 1)
        _, _, key = model_endpoints.realtime_runtime(free_voice.current()["id"])
        self.assertTrue(key.endswith("t"))

    async def test_another_live_model_is_used_when_the_default_is_not_offered(self):
        self.google.models = self.google.models[2:]
        self.assertEqual((await free_voice.check(KEY))["model"], "gemini-2.5-flash-native-audio-preview")

    async def test_paged_model_lists_are_read_to_the_end(self):
        free_voice.TRANSPORT = Google(pages=True).transport
        self.assertIn("gemini-3.1-flash-live-preview", (await free_voice.check(KEY))["live_models"])

    async def test_honest_errors_and_nothing_saved(self):
        for status, words in ((400, "did not accept"), (403, "did not accept"), (429, "free limit"), (500, "error (500)")):
            free_voice.TRANSPORT = Google(status=status).transport
            with self.assertRaises(free_voice.FreeVoiceError) as caught:
                await free_voice.connect(KEY)
            self.assertIn(words, str(caught.exception))
        free_voice.TRANSPORT = Google(models=[{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]).transport
        with self.assertRaises(free_voice.FreeVoiceError) as caught:
            await free_voice.connect(KEY)
        self.assertIn("no Live voice model", str(caught.exception))

        def offline(request):
            raise httpx.ConnectError("offline")
        free_voice.TRANSPORT = httpx.MockTransport(offline)
        with self.assertRaises(free_voice.FreeVoiceError) as caught:
            await free_voice.connect(KEY)
        self.assertIn("Could not reach Google", str(caught.exception))
        for bad in ("", "short", "has spaces in the middle of it but long enough", KEY + "!"):
            with self.assertRaises(free_voice.FreeVoiceError):
                await free_voice.check(bad)
        self.assertEqual(model_endpoints.list_endpoints(), [])

    async def test_free_minutes_are_counted_without_cost(self):
        realtime_usage.USAGE_FILE = os.path.join(_DATA.name, "usage.json")
        try:
            row = realtime_usage.record("gemini", 120, free=True)
            self.assertEqual((row["seconds"], row["cost_estimate"]), (120.0, 0.0))
            row = realtime_usage.record("gemini", 60)
            self.assertGreater(row["cost_estimate"], 0)
        finally:
            realtime_usage.USAGE_FILE = None

    def test_routes(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core.middleware import require_user
        from routes.model_routes import router
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_user] = lambda: "local"
        client = TestClient(app)
        self.assertEqual(client.get("/api/models/free-voice").json()["configured"], False)
        self.assertEqual(client.get("/api/models/free-voice").json()["key_page"], "https://aistudio.google.com/apikey")
        bad = client.post("/api/models/free-voice", json={"api_key": "nope"})
        self.assertEqual(bad.status_code, 422)
        good = client.post("/api/models/free-voice", json={"api_key": KEY})
        self.assertEqual(good.status_code, 200, good.text)
        self.assertNotIn(KEY, good.text)
        self.assertTrue(client.get("/api/models/free-voice").json()["configured"])


if __name__ == "__main__":
    unittest.main()
