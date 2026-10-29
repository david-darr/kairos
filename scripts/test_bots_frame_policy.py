"""A response keeps its own Content-Security-Policy only on the two allowed paths (core/middleware.py):
a Design board's render and a bot's sandboxed app page. Anywhere else the render header is ignored and dropped."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.middleware import SecurityHeadersMiddleware  # noqa: E402

OWN = "default-src 'none'; script-src 'sha256-abc'"


def own_policy():
    return HTMLResponse("<p>page</p>", headers={"Content-Security-Policy": OWN, "X-Kairos-Design-Render": "1"})


app = FastAPI()
app.add_middleware(SecurityHeadersMiddleware)
for path in ("/api/designs/d1/boards/home/render", "/api/bot-widgets/s1/apps/m1/frame", "/api/agents/x", "/api/bot-widgets/s1/apps/m1"):
    app.add_api_route(path, own_policy)


class FramePolicyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_allowed_paths_keep_their_policy(self):
        for path in ("/api/designs/d1/boards/home/render", "/api/bot-widgets/s1/apps/m1/frame"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.headers["Content-Security-Policy"], OWN)
                self.assertEqual(response.headers["X-Frame-Options"], "SAMEORIGIN")
                self.assertNotIn("X-Kairos-Design-Render", response.headers)

    def test_any_other_path_gets_the_app_policy(self):
        for path in ("/api/agents/x", "/api/bot-widgets/s1/apps/m1"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertNotEqual(response.headers["Content-Security-Policy"], OWN)
                self.assertIn("script-src 'self'", response.headers["Content-Security-Policy"])
                self.assertEqual(response.headers["X-Frame-Options"], "DENY")
                self.assertNotIn("X-Kairos-Design-Render", response.headers)


if __name__ == "__main__":
    unittest.main()
