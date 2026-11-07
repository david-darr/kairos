"""Browse's backend route (vault: "Kairos Browser - Phase 1 (Build Spec)").

- Sharing a page from Browse marks the chat as carrying outside content, so
  the taint rules apply to its turns (services/chat_service.py _taint_turn).
- Only the person's own chat can be marked, and only with the known fields.
- The route is cookie-only: a paired terminal cannot use it.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
environment = tempfile.TemporaryDirectory(prefix="kairos-browse-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx
from fastapi import FastAPI

from core import cli_access, middleware, session_manager_store as store
from core.auth import SINGLE_USER
from core.session_manager import session_manager
from routes import browse_routes


def tearDownModule():
    store.close()
    environment.cleanup()


class SharedPageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = session_manager.create_session("Browse fixture", owner_user=SINGLE_USER)
        self.id = self.session["id"]
        self.app = FastAPI()
        self.app.include_router(browse_routes.router)
        self.app.dependency_overrides[middleware.require_user] = lambda: SINGLE_USER

    async def asyncTearDown(self):
        store.delete_all_sessions()

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://browse")

    async def test_a_shared_page_marks_the_chat_untrusted(self):
        async with self.client() as client:
            response = await client.post("/api/browse/shared", json={"session_id": self.id})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(session_manager.get_session(self.id)["untrusted_context"], "a web page shared from Browse")

    async def test_an_unknown_chat_is_refused_and_nothing_is_marked(self):
        async with self.client() as client:
            response = await client.post("/api/browse/shared", json={"session_id": "no-such-chat"})
        self.assertGreaterEqual(response.status_code, 400)
        self.assertIsNone(session_manager.get_session(self.id).get("untrusted_context"))

    async def test_unknown_fields_are_refused(self):
        async with self.client() as client:
            response = await client.post("/api/browse/shared", json={"session_id": self.id, "reason": "trusted"})
        self.assertEqual(response.status_code, 422)
        self.assertIsNone(session_manager.get_session(self.id).get("untrusted_context"))


class CookieOnlyTests(unittest.TestCase):
    def test_a_terminal_token_cannot_reach_the_browse_routes(self):
        self.assertFalse(cli_access.token_route_allowed("/api/browse/shared"))
        self.assertTrue(cli_access.token_route_allowed("/api/chat/live"))


if __name__ == "__main__":
    unittest.main()
