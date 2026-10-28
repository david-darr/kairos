"""Add Models / Added Models: validation, secrets, probes, removal, no default.

Covers what test_model_discovery.py, test_antigravity.py and test_model_setup.py
leave open for A14: a bad model ID or key answers honestly through the Test
button (against a real loopback server, not a mock of our own code), a
provider that never answers is a reported failure rather than a hang, removing
a connection leaves chats with the "add a model" message instead of silently
using another model, members cannot see URLs or keys, and the model catalog
route degrades to its fallback when discovery fails. No account, key or
network beyond 127.0.0.1.

    .venv\\Scripts\\python.exe scripts\\test_model_endpoints.py
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="g7-models-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi.testclient import TestClient

from app import app
from core import model_discovery, model_endpoints
from core.auth import SESSION_COOKIE_NAME, auth_manager
from core.session_manager import session_manager
from services import chat_service

logging.disable(logging.CRITICAL)
KEY = "sk-test-KEY-never-echo-0123456789"


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        Handler.seen.append((self.path, body.get("model"), self.headers.get("Authorization")))
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self.reply(401, {"error": {"message": "Incorrect API key provided"}})
        if body.get("model") != "good-model":
            return self.reply(404, {"error": {"message": f"The model `{body.get('model')}` does not exist"}})
        self.reply(200, {"choices": [{"message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Models(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"
        auth_manager._users = {"users": {}}; auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        auth_manager.create_user("member", "member-password-1")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        from core import session_manager_store
        session_manager_store.close()

    def setUp(self):
        Handler.seen.clear()
        for endpoint in model_endpoints.list_endpoints():
            model_endpoints.delete_endpoint(endpoint["id"])

    def add(self, **body):
        made = self.admin.post("/api/models", json={"name": "Test", "kind": "api", "base_url": self.base, "model": "good-model", "api_key": KEY, **body})
        self.assertEqual(made.status_code, 200, made.text)
        return made.json()

    # -- nothing is invented ------------------------------------------------------

    def test_a_fresh_install_has_no_model_and_a_chat_says_so_without_calling_anyone(self):
        self.assertEqual(self.admin.get("/api/models").json(), [])
        self.assertEqual(self.member.get("/api/models/choices").json(), [], "the picker offers nothing, not a built-in default")
        sid = session_manager.create_session("fresh", owner_user="boss")["id"]
        self.addCleanup(session_manager.delete_session, sid)
        with patch("core.providers.openai_compatible.run_turn", new=AsyncMock(side_effect=AssertionError("a model was called"))), \
                patch("services.chat_service._get_brain", new=AsyncMock(side_effect=AssertionError("a brain was started"))):
            reply = asyncio.run(chat_service.send_message(sid, "hello", []))
        self.assertEqual(reply, chat_service.NO_MODEL_MESSAGE)

    def test_removing_a_connection_leaves_its_chats_with_no_model_not_another_one(self):
        keep = self.add(name="Keep")
        gone = self.add(name="Gone")
        sid = session_manager.create_session("c", owner_user="boss")["id"]
        self.addCleanup(session_manager.delete_session, sid)
        session_manager.set_model_endpoint(sid, gone["id"])
        self.assertEqual(self.admin.delete(f"/api/models/{gone['id']}").json(), {"ok": True})
        self.assertEqual(self.admin.delete(f"/api/models/{gone['id']}").status_code, 404)
        self.assertEqual([e["id"] for e in self.admin.get("/api/models").json()], [keep["id"]])
        self.assertIsNone(chat_service._resolve_endpoint(sid), "the other connection must not stand in")
        with patch("services.chat_service._get_brain", new=AsyncMock(side_effect=AssertionError("a brain was started"))):
            self.assertEqual(asyncio.run(chat_service.send_message(sid, "hi", [])), chat_service.NO_MODEL_MESSAGE)

    # -- adding: validation, secrets, who may see what ------------------------------

    def test_bad_input_is_refused_and_secrets_are_not_stored_or_shown_in_plain(self):
        for body in ({"name": "x", "kind": "mystery"}, {"name": "x", "kind": "api", "base_url": ""}, {"name": "x", "kind": "local", "base_url": ""}):
            self.assertEqual(self.admin.post("/api/models", json=body).status_code, 400, body)
        self.assertEqual(self.admin.post("/api/models", json={"kind": "api"}).status_code, 422, "a name is required")
        self.assertEqual(model_endpoints.list_endpoints(), [], "refused requests saved nothing")
        made = self.add()
        self.assertNotIn(KEY, Path(model_endpoints.ENDPOINTS_FILE).read_text(encoding="utf-8"), "the key is encrypted at rest")
        self.assertNotIn(KEY, json.dumps(made))
        self.assertTrue(made["has_api_key"])
        self.assertNotIn(KEY, self.admin.get("/api/models").text)
        self.assertEqual(self.add(base_url=self.base + "/")["base_url"], self.base, "a trailing slash is trimmed")
        local = self.add(kind="local", api_key=None)
        self.assertEqual(local["num_ctx"], model_endpoints.DEFAULT_LOCAL_NUM_CTX, "a local engine always gets a context cap")

    def test_cli_connections_need_no_url_and_no_model_is_chosen_for_them(self):
        for kind in ("claude_cli", "codex_cli", "antigravity_cli"):
            made = self.admin.post("/api/models", json={"name": kind, "kind": kind}).json()
            self.assertEqual((made["model"], made["base_url"], made["has_api_key"], made["supports_images"]), ("", "", False, True), kind)

    def test_members_may_pick_a_model_but_never_see_urls_or_keys_or_change_connections(self):
        made = self.add()
        choices = self.member.get("/api/models/choices")
        self.assertEqual(choices.status_code, 200)
        text = choices.text
        for secret in (KEY, self.base, "base_url", "has_api_key"):
            self.assertNotIn(secret, text)
        for method, path, body in (("get", "", None), ("post", "", {"name": "x"}), ("delete", f"/{made['id']}", None),
                                   ("post", f"/{made['id']}/test", {}), ("patch", f"/{made['id']}/image-support", {"enabled": True}),
                                   ("get", "/usage", None), ("get", "/quotas", None)):
            for who, c in (("member", self.member), ("anonymous", self.anon)):
                got = getattr(c, method)("/api/models" + path, **({} if body is None else {"json": body}))
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
        self.assertEqual(self.anon.get("/api/models/choices").status_code, 401)

    # -- probing: bad IDs, bad keys, timeouts -------------------------------------------

    def test_the_test_button_reports_success_a_bad_model_id_a_bad_key_and_a_dead_server(self):
        good = self.add()
        result = self.admin.post(f"/api/models/{good['id']}/test").json()
        self.assertTrue(result["ok"], result)
        self.assertGreaterEqual(result["latency_ms"], 0)
        self.assertEqual(Handler.seen[-1], ("/v1/chat/completions", "good-model", f"Bearer {KEY}"), "one small request, to the saved model")
        self.assertEqual(len(Handler.seen), 1, "testing costs exactly one request")
        bad_id = self.add(model="no-such-model")
        failed = self.admin.post(f"/api/models/{bad_id['id']}/test").json()
        self.assertFalse(failed["ok"])
        self.assertIn("404", failed["detail"])
        bad_key = self.add(api_key="wrong-key-value")
        rejected = self.admin.post(f"/api/models/{bad_key['id']}/test").json()
        self.assertFalse(rejected["ok"])
        self.assertIn("401", rejected["detail"])
        for text in (json.dumps(failed), json.dumps(rejected)):
            self.assertNotIn(KEY, text)
            self.assertNotIn("wrong-key-value", text, "a failed test never echoes the key")
        dead = self.add(base_url="http://127.0.0.1:9/v1")
        refused = self.admin.post(f"/api/models/{dead['id']}/test").json()
        self.assertFalse(refused["ok"])
        self.assertTrue(refused["detail"])
        self.assertLessEqual(len(refused["detail"]), 300, "the reason is bounded")

    def test_a_provider_that_times_out_is_a_reported_failure(self):
        made = self.add()
        with patch("routes.model_routes.openai_compatible.run_turn", new=AsyncMock(side_effect=httpx.ReadTimeout("timed out"))):
            result = self.admin.post(f"/api/models/{made['id']}/test").json()
        self.assertEqual(result["ok"], False)
        self.assertEqual(self.admin.post("/api/models/missing/test").status_code, 404)

    def test_image_support_is_only_editable_for_api_and_local_connections(self):
        api = self.add()
        self.assertTrue(self.admin.patch(f"/api/models/{api['id']}/image-support", json={"enabled": True}).json()["supports_images"])
        cli = self.admin.post("/api/models", json={"name": "c", "kind": "claude_cli"}).json()
        self.assertEqual(self.admin.patch(f"/api/models/{cli['id']}/image-support", json={"enabled": False}).status_code, 400)
        self.assertEqual(self.admin.patch("/api/models/missing/image-support", json={"enabled": False}).status_code, 404)

    # -- discovery degrades instead of inventing models -------------------------------------

    def test_discovery_with_no_key_or_a_failing_provider_returns_the_fallback_not_invented_ids(self):
        model_discovery._cache.clear()
        custom = self.add()  # a custom URL is not a known provider: nothing to discover
        self.assertEqual(self.member.get(f"/api/models/{custom['id']}/catalog").json(), [])
        self.assertEqual(self.member.get("/api/models/missing/catalog").status_code, 404)
        official = {"id": "ep1", "kind": "api", "base_url": "https://api.openai.com/v1", "api_key_encrypted": None}
        self.assertEqual(asyncio.run(model_discovery.list_for_endpoint(official)), [], "no key: nothing is invented")
        from core.secret_storage import encrypt
        official["api_key_encrypted"] = encrypt("k")
        with patch("core.model_discovery._openai_models", new=AsyncMock(side_effect=httpx.ConnectTimeout("slow"))):
            self.assertEqual(asyncio.run(model_discovery.list_for_endpoint(official)), [], "a timeout with nothing cached is empty")
        live = [model_discovery._entry("gpt-live", source="openai_api")]
        with patch("core.model_discovery._openai_models", new=AsyncMock(return_value=live)):
            self.assertEqual([m["id"] for m in asyncio.run(model_discovery.list_for_endpoint(official, force=True))], ["gpt-live"])
        with patch("core.model_discovery._openai_models", new=AsyncMock(side_effect=httpx.ConnectTimeout("slow"))):
            again = asyncio.run(model_discovery.list_for_endpoint(official, force=True))
        self.assertEqual([m["id"] for m in again], ["gpt-live"], "a later failure keeps the last good list")
        model_discovery._cache.clear()

    def test_discovery_is_cached_so_reopening_the_picker_makes_no_new_request(self):
        model_discovery._cache.clear()
        from core.secret_storage import encrypt
        endpoint = {"id": "ep2", "kind": "api", "base_url": "https://api.openai.com/v1", "api_key_encrypted": encrypt("k")}
        fetch = AsyncMock(return_value=[model_discovery._entry("gpt-live", source="openai_api")])
        with patch("core.model_discovery._openai_models", new=fetch):
            for _ in range(5):
                asyncio.run(model_discovery.list_for_endpoint(endpoint))
        self.assertEqual(fetch.await_count, 1, "five opens, one provider request")
        model_discovery._cache.clear()


if __name__ == "__main__":
    unittest.main()
