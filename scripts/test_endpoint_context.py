"""A local server's API key and a custom provider's context window.

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_endpoint_context.py
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="endpoint-context-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import model_endpoints, tab_api  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes import model_routes  # noqa: E402
from services import chat_service  # noqa: E402


class EndpointContextTests(unittest.TestCase):
    def setUp(self):
        self.created = []
        self.addCleanup(lambda: [model_endpoints.delete_endpoint(e) for e in self.created])
        app = FastAPI()
        app.include_router(model_routes.router)
        app.dependency_overrides[require_admin] = lambda: "admin"
        self.web = TestClient(app)

    def add(self, **body):
        response = self.web.post("/api/models", json={"name": "m", "base_url": "http://127.0.0.1:8080/v1",
                                                      "model": "qwen", **body})
        if response.status_code == 200:
            self.created.append(response.json()["id"])
        return response

    def test_a_local_server_can_take_an_api_key(self):
        ep = self.add(kind="local", api_key="sk-local", num_ctx=8192).json()
        self.assertTrue(ep["has_api_key"])
        self.assertNotIn("sk-local", str(ep))
        self.assertEqual(model_endpoints.resolve_runtime(ep["id"])[2:], ("sk-local", 8192))

    def test_a_custom_provider_keeps_its_window_but_never_sends_it(self):
        ep = self.add(kind="api", api_key="sk-api", num_ctx=8192).json()
        self.assertEqual(ep["num_ctx"], 8192)
        self.assertEqual(model_endpoints.resolve_runtime(ep["id"])[2:], ("sk-api", None))
        raw = model_endpoints.get_endpoint(ep["id"])
        self.assertEqual(model_endpoints.context_capacity(raw)["window"], 8192)
        self.assertEqual(tab_api.model_context_size(ep["id"]), 8192)

    def test_a_small_custom_window_gets_the_deferred_tool_list(self):
        small = model_endpoints.get_endpoint(self.add(kind="api", num_ctx=8192).json()["id"])
        large = model_endpoints.get_endpoint(self.add(kind="api", num_ctx=131072).json()["id"])
        self.assertTrue(chat_service._build_brain(small, None).small_window)
        self.assertFalse(chat_service._build_brain(large, None).small_window)

    def test_without_a_window_an_api_model_falls_back_to_the_catalog(self):
        ep = model_endpoints.get_endpoint(self.add(kind="api").json()["id"])
        self.assertIsNone(ep["num_ctx"])
        self.assertIsNone(model_endpoints.context_capacity(ep))
        self.assertIsNone(chat_service._build_brain(ep, None).num_ctx)

    def test_a_local_server_without_a_window_still_counts_as_small(self):
        ep = model_endpoints.get_endpoint(self.add(kind="local").json()["id"])
        self.assertEqual(ep["num_ctx"], model_endpoints.DEFAULT_LOCAL_NUM_CTX)
        self.assertTrue(chat_service._build_brain({**ep, "num_ctx": None}, None).small_window)

    def test_a_window_below_the_minimum_is_refused(self):
        for value in (0, -1, 512):
            self.assertEqual(self.add(kind="api", num_ctx=value).status_code, 400, value)
        self.assertEqual(self.add(kind="claude_cli", base_url="", num_ctx=8192).json()["num_ctx"], None)


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()
    fixture.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
