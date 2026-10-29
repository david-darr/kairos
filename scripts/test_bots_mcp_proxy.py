"""Bots redesign, Phase 2 unit U4: the bot-scoped MCP proxy for Claude (2026-10-29).

The proxy holds a loopback capability and nothing else. Tested two ways: its handlers against a stand-in
backend, and as a real stdio server driven by the MCP client against a small local HTTP backend.
Run: python scripts/test_bots_mcp_proxy.py
"""
import asyncio
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from mcp_servers import bot_mcp_proxy  # noqa: E402

PROXY = str(Path(bot_mcp_proxy.__file__).resolve())


def run(coro):
    return asyncio.run(coro)


def transport(log, tokens=("tok1",), expires=3600):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        log.append((request.url.path, request.headers.get("x-jarvis-tool-token"), body))
        if request.url.path.endswith("/_mcp/list"):
            return httpx.Response(200, json={"tools": [{"name": "github__list_issues", "description": "List issues.",
                                                         "schema": {"type": "object", "properties": {"repo": {"type": "string"}}}}],
                                             "expires_in": expires})
        if request.url.path.endswith("/_mcp/call"):
            text = "Not allowed: nope." if body["name"] == "blocked" else f"called {body['name']} {body['arguments']}"
            return httpx.Response(200, json={"result": text, "expires_in": expires})
        if request.url.path.endswith("/_mcp/renew"):
            return httpx.Response(200, json={"token": "tok2", "expires_in": 1800})
        return httpx.Response(404)
    return httpx.MockTransport(handler)


class Handlers(unittest.TestCase):
    def build(self, **kw):
        log = []
        backend = bot_mcp_proxy.Backend("http://127.0.0.1:1/api", "tok1", transport(log, **kw))
        return log, backend, bot_mcp_proxy.build(backend)

    def test_list_sends_only_the_capability_and_shapes_tools(self):
        log, backend, server = self.build()
        # The handlers are reached through a real server in EndToEnd below; here the backend call itself.
        data = run(backend.post("_mcp/list"))
        self.assertEqual(data["tools"][0]["name"], "github__list_issues")
        self.assertEqual(log[-1][1], "tok1")
        self.assertEqual(log[-1][0], "/api/tools/_mcp/list")

    def test_a_capability_near_expiry_is_renewed_and_the_new_one_used(self):
        log, backend, _ = self.build(expires=100)
        run(backend.post("_mcp/call", {"name": "x", "arguments": {}}))
        self.assertEqual(backend.token, "tok2")
        run(backend.post("_mcp/call", {"name": "y", "arguments": {}}))
        self.assertEqual(log[-1][1], "tok2")

    def test_a_failed_renewal_changes_nothing(self):
        def broken(request):
            if request.url.path.endswith("/renew"):
                return httpx.Response(403)
            return httpx.Response(200, json={"result": "ok", "expires_in": 5})
        backend = bot_mcp_proxy.Backend("http://x/api", "tok1", httpx.MockTransport(broken))
        run(backend.post("_mcp/call", {"name": "x", "arguments": {}}))
        self.assertEqual(backend.token, "tok1")


class FakeBackend(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        FakeBackend.seen.append((self.path, self.headers.get("X-JARVIS-Tool-Token"), body))
        if self.headers.get("X-JARVIS-Tool-Token") != "good":
            self.send_response(403)
            self.end_headers()
            return
        if self.path.endswith("/_mcp/list"):
            payload = {"tools": [{"name": "github__list_issues", "description": "List issues.",
                                  "schema": {"type": "object", "properties": {"repo": {"type": "string"}}}}], "expires_in": 3600}
        else:
            text = "Not allowed: this bot's tool selection excludes it." if body["name"] == "blocked" else f"ten issues for {body['arguments'].get('repo')}"
            payload = {"result": text, "expires_in": 3600}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), FakeBackend)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}/api"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    async def session(self, token, work):
        from mcp.client import Client
        from mcp.client.stdio import StdioServerParameters
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME")}
        env.update(JARVIS_TOOL_TOKEN=token, JARVIS_API_BASE=self.base)
        params = StdioServerParameters(command=sys.executable, args=["-I", PROXY], env=env)
        async with Client(params, read_timeout_seconds=30) as client:
            return await work(client)

    def test_lists_and_calls_through_a_real_stdio_server(self):
        FakeBackend.seen.clear()

        async def work(client):
            listed = await client.list_tools()
            called = await client.call_tool("github__list_issues", {"repo": "kairos"})
            refused = await client.call_tool("blocked", {})
            return listed, called, refused
        listed, called, refused = run(self.session("good", work))
        self.assertEqual([t.name for t in listed.tools], ["github__list_issues"])
        self.assertEqual(listed.tools[0].input_schema["properties"]["repo"]["type"], "string")
        self.assertEqual(called.content[0].text, "ten issues for kairos")
        self.assertFalse(getattr(called, "is_error", False))
        self.assertTrue(refused.is_error)
        self.assertIn("Not allowed", refused.content[0].text)
        self.assertTrue(all(token == "good" for _, token, _ in FakeBackend.seen), "only the capability is ever sent")

    def test_an_expired_capability_lists_nothing_and_calls_fail(self):
        async def work(client):
            return await client.list_tools(), await client.call_tool("github__list_issues", {})
        listed, called = run(self.session("expired", work))
        self.assertEqual(listed.tools, [])
        self.assertTrue(called.is_error)

    def test_it_refuses_to_start_without_a_capability(self):
        import subprocess
        env = {k: v for k, v in os.environ.items() if k not in ("JARVIS_TOOL_TOKEN", "JARVIS_API_BASE")}
        done = subprocess.run([sys.executable, "-I", PROXY], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 1)
        self.assertIn("only when Kairos starts it", done.stderr)

    def test_the_proxy_source_holds_no_upstream_credentials(self):
        source = Path(PROXY).read_text(encoding="utf-8")
        for word in ("api_key", "Authorization", "integrations", "decrypt"):
            self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main()
