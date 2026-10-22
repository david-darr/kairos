"""Kairos CLI terminal pairing (core/cli_access.py, routes/cli_routes.py).

What matters is the refusals. A terminal gets a token only after a click in
the app window; without one, with a revoked one, or on a cookie-only route,
it gets nothing; and nothing a terminal (or an agent's shell posing as one)
can do approves its own pairing.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = tempfile.TemporaryDirectory(prefix="jarvis-cli-access-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx
from fastapi import FastAPI
from unittest.mock import patch

from core import auth as auth_module, cli_access, permissions
from routes import (auth_routes, chat_routes, cli_routes, permission_routes, remote_routes, session_routes,
                    system_routes)
from services import chat_live

SECRET = "per-launch-secret-for-cli-tests"
APP_WINDOW = {"Cookie": f"jarvis_ui={SECRET}"}


class PairingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=environment.name)
        self.patches = [
            patch.object(permissions, "PERMISSIONS_FILE", os.path.join(self.directory.name, "permissions.json")),
            patch.object(auth_module, "UI_SECRET", SECRET),
            patch.dict(os.environ, {"AUTH_ENABLED": "false"}),
        ]
        for item in self.patches:
            item.start()
        permissions._session_rules.clear()
        permissions._channels.clear()
        permissions._pending.clear()
        cli_access.reset()
        self.app = FastAPI()
        for module in (auth_routes, chat_routes, cli_routes, permission_routes, remote_routes, session_routes,
                       system_routes):
            self.app.include_router(module.router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.feed, _ = chat_live.subscribe()

    async def asyncTearDown(self):
        chat_live.unsubscribe(self.feed)
        cli_access.reset()
        await self.client.aclose()
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    # -- helpers ----------------------------------------------------------

    async def pair(self):
        response = await self.client.post("/api/auth/cli-pair", json={"pid": 4242, "terminal": "Windows Terminal"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def prompt(self):
        """The pairing prompt as the app window receives it on the live feed."""
        for _ in range(50):
            await asyncio.sleep(0.01)
            while not self.feed.empty():
                packet = self.feed.get_nowait()
                if packet.get("type") == "cli_pair":
                    return packet["request"]
        self.fail("no pairing prompt reached the live feed")

    async def answer(self, request_id, choice, headers=APP_WINDOW):
        return await self.client.post(f"/api/permissions/{request_id}/answer", json={"choice": choice}, headers=headers)

    async def claim(self, started, wait=2):
        response = await self.client.post(f"/api/auth/cli-pair/{started['request_id']}/claim",
                                          json={"claim": started["claim"], "wait": wait})
        return response

    async def paired_token(self):
        started = await self.pair()
        request = await self.prompt()
        self.assertEqual((await self.answer(request["id"], "allow")).status_code, 200)
        result = (await self.claim(started)).json()
        self.assertEqual(result["status"], "allowed")
        return result["token"]

    # -- the happy path, once ---------------------------------------------

    async def test_a_click_in_the_app_pairs_the_terminal(self):
        started = await self.pair()
        self.assertRegex(started["words"], r"^[a-z]+-[a-z]+$")
        request = await self.prompt()
        self.assertIn(started["words"], request["title"])
        self.assertEqual([c["id"] for c in request["choices"]], ["allow", "reject"])
        self.assertEqual(request["choices"][0]["label"], "Allow until this terminal closes")
        self.assertEqual((await self.answer(request["id"], "allow")).status_code, 200)
        result = (await self.claim(started)).json()
        self.assertEqual(result["status"], "allowed")
        token = {cli_access.HEADER: result["token"]}
        self.assertEqual((await self.client.get("/api/sessions", headers=token)).status_code, 200)
        status = (await self.client.get("/api/auth/status", headers=token)).json()
        self.assertEqual(status["username"], "local")
        # Handed over exactly once.
        self.assertEqual((await self.claim(started)).status_code, 404)

    async def test_the_token_is_never_written_to_disk(self):
        token = await self.paired_token()
        for root, _dirs, files in os.walk(environment.name):
            for name in files:
                with open(os.path.join(root, name), "rb") as handle:
                    self.assertNotIn(token.encode(), handle.read(), name)

    # -- fails closed -----------------------------------------------------

    async def test_rejecting_gives_no_token(self):
        started = await self.pair()
        request = await self.prompt()
        await self.answer(request["id"], "reject")
        result = (await self.claim(started)).json()
        self.assertEqual(result["status"], "rejected")
        self.assertNotIn("token", result)

    async def test_ignoring_the_prompt_times_out_to_no_token(self):
        with patch.object(cli_access, "PAIR_TIMEOUT_SECONDS", 0.2):
            started = await self.pair()
            await self.prompt()
            result = (await self.claim(started, wait=5)).json()
        self.assertEqual(result["status"], "expired")
        self.assertNotIn("token", result)

    async def test_closing_the_prompt_rejects(self):
        # static/js/permissionPrompt.js sends the reject choice on close.
        started = await self.pair()
        request = await self.prompt()
        await self.answer(request["id"], "reject")
        self.assertEqual((await self.claim(started)).json()["status"], "rejected")

    async def test_a_pending_claim_says_so_without_a_token(self):
        started = await self.pair()
        await self.prompt()
        result = (await self.claim(started, wait=0)).json()
        self.assertEqual(result, {"status": "pending"})

    async def test_the_wrong_claim_secret_collects_nothing(self):
        started = await self.pair()
        request = await self.prompt()
        await self.answer(request["id"], "allow")
        stolen = await self.client.post(f"/api/auth/cli-pair/{started['request_id']}/claim",
                                        json={"claim": "guessed", "wait": 0})
        self.assertEqual(stolen.status_code, 404)
        self.assertEqual((await self.claim(started)).json()["status"], "allowed")

    # -- the agent-shell threat -------------------------------------------

    async def test_an_agent_shell_cannot_get_a_token_without_the_click(self):
        """Everything a process on this machine can do without the app
        window's cookie: ask to pair, try to answer its own prompt (with no
        credential, with a guessed cookie, and with another terminal's
        token), and read the live feed. None of it issues a token."""
        other_terminal = {cli_access.HEADER: await self.paired_token()}
        started = await self.pair()
        request = await self.prompt()
        for headers in ({}, {"Cookie": "jarvis_ui=guess"}, other_terminal):
            for choice in ("allow", "reject"):
                response = await self.answer(request["id"], choice, headers=headers)
                self.assertIn(response.status_code, (401, 404), (headers, choice, response.text))
        # A token holder's view of the feed never carries the prompt.
        snapshot = (await self.client.get("/api/chat/live/snapshot", headers=other_terminal)).json()
        self.assertNotIn("cliPairs", snapshot)
        self.assertIsNone(chat_live.visible_packet({"type": "cli_pair", "request": request}, "local", False))
        window = (await self.client.get("/api/chat/live/snapshot", headers=APP_WINDOW)).json()
        self.assertEqual([p["id"] for p in window["cliPairs"]], [request["id"]])
        # Still waiting: nothing above approved it.
        self.assertEqual((await self.claim(started, wait=0)).json(), {"status": "pending"})

    async def test_a_saved_rule_can_never_stand_in_for_the_click(self):
        permissions.grant_standing([cli_access.TOOL], "someone")
        started = await self.pair()
        await self.prompt()
        self.assertEqual((await self.claim(started, wait=0)).json(), {"status": "pending"})

    async def test_only_one_pending_pair_and_a_few_a_minute(self):
        await self.pair()
        second = await self.client.post("/api/auth/cli-pair", json={"pid": 1, "terminal": "again"})
        self.assertEqual(second.status_code, 429)
        cli_access.reset()
        cli_access._recent.extend([time.time()] * cli_access.PAIRS_PER_MINUTE)
        flood = await self.client.post("/api/auth/cli-pair", json={"pid": 1, "terminal": "flood"})
        self.assertEqual(flood.status_code, 429)

    async def test_pairing_is_loopback_only(self):
        remote = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("192.168.1.20", 5000)),
                                   base_url="http://test")
        async with remote:
            self.assertEqual((await remote.post("/api/auth/cli-pair", json={})).status_code, 403)
        token = await self.paired_token()
        remote = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("192.168.1.20", 5000)),
                                   base_url="http://test")
        async with remote:
            self.assertEqual((await remote.get("/api/sessions", headers={cli_access.HEADER: token})).status_code, 401)

    async def test_terminal_labels_are_plain_text(self):
        response = await self.client.post("/api/auth/cli-pair",
                                          json={"pid": 1, "terminal": "\x1b[31mevil\x07 terminal"})
        request = await self.prompt()
        self.assertEqual(json.loads(request["arguments"])["terminal"], "[31mevil terminal")
        self.assertEqual(response.status_code, 200)

    # -- what a token opens, and what it never does ------------------------

    async def test_no_token_or_a_wrong_one_gets_401(self):
        for headers in ({}, {cli_access.HEADER: "kcli_guess"}, {cli_access.HEADER: ""}):
            self.assertEqual((await self.client.get("/api/sessions", headers=headers)).status_code, 401)

    async def test_cookie_only_routes_refuse_a_token(self):
        token = {cli_access.HEADER: await self.paired_token()}
        for method, path in [("GET", "/api/system/backup/export"), ("GET", "/api/system/backup/full"),
                             ("POST", "/api/system/wipe"), ("GET", "/api/system/wipe-kinds"),
                             ("GET", "/api/system/tabs/notes/export"), ("POST", "/api/auth/ui-code"),
                             ("GET", "/api/auth/users"), ("POST", "/api/remote/enable"),
                             ("GET", "/api/remote/status"), ("GET", "/api/auth/cli/terminals")]:
            with self.subTest(path=path):
                response = await self.client.request(method, path, headers=token, json={"kind": "notes"})
                self.assertEqual(response.status_code, 401, response.text)

    async def test_a_revoked_token_gets_401(self):
        token = {cli_access.HEADER: await self.paired_token()}
        terminals = (await self.client.get("/api/auth/cli/terminals", headers=APP_WINDOW)).json()["terminals"]
        self.assertEqual(len(terminals), 1)
        revoked = await self.client.delete(f"/api/auth/cli/terminals/{terminals[0]['id']}", headers=APP_WINDOW)
        self.assertEqual(revoked.status_code, 200)
        self.assertEqual((await self.client.get("/api/sessions", headers=token)).status_code, 401)

    async def test_a_terminal_cannot_revoke_or_list_from_settings(self):
        token = {cli_access.HEADER: await self.paired_token()}
        terminal_id = cli_access.list_terminals()[0]["id"]
        self.assertEqual((await self.client.delete(f"/api/auth/cli/terminals/{terminal_id}", headers=token)).status_code, 401)

    async def test_goodbye_heartbeat_idle_and_age(self):
        token = {cli_access.HEADER: await self.paired_token()}
        self.assertEqual((await self.client.post("/api/auth/cli/heartbeat", headers=token)).status_code, 200)
        self.assertEqual((await self.client.delete("/api/auth/cli/session", headers=token)).status_code, 200)
        self.assertEqual((await self.client.get("/api/sessions", headers=token)).status_code, 401)
        token = {cli_access.HEADER: await self.paired_token()}
        record = next(iter(cli_access._terminals.values()))
        record.last_seen -= cli_access.IDLE_SECONDS + 1
        self.assertEqual((await self.client.post("/api/auth/cli/heartbeat", headers=token)).status_code, 401)
        token = {cli_access.HEADER: await self.paired_token()}
        record = next(iter(cli_access._terminals.values()))
        record.expires_at = time.time() - 1
        self.assertEqual((await self.client.get("/api/sessions", headers=token)).status_code, 401)

    async def test_every_step_is_audited(self):
        token = {cli_access.HEADER: await self.paired_token()}
        await self.client.delete("/api/auth/cli/session", headers=token)
        decisions = [entry["decision"] for entry in permissions.audit()]
        for expected in ("cli_pair_requested", "allow", "cli_token_issued", "cli_token_revoked"):
            self.assertIn(expected, decisions)

    async def test_accounts_on_or_an_open_backend_need_no_pairing(self):
        with patch.dict(os.environ, {"AUTH_ENABLED": "true"}):
            self.assertEqual((await self.client.post("/api/auth/cli-pair", json={})).status_code, 409)
        with patch.object(auth_module, "UI_SECRET", None):
            self.assertEqual((await self.client.post("/api/auth/cli-pair", json={})).status_code, 409)

    async def test_with_accounts_on_a_token_opens_nothing(self):
        token = {cli_access.HEADER: await self.paired_token()}
        with patch.dict(os.environ, {"AUTH_ENABLED": "true"}):
            self.assertEqual((await self.client.get("/api/sessions", headers=token)).status_code, 401)


class LaunchFolderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(session_routes.router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.secret = patch.object(auth_module, "UI_SECRET", None)
        self.secret.start()

    async def asyncTearDown(self):
        self.secret.stop()
        await self.client.aclose()

    async def test_a_cli_chat_records_its_folder_and_lists_it(self):
        folder = str(Path(environment.name).resolve())
        created = (await self.client.post("/api/sessions", json={"title": "From a terminal", "launch_dir": folder})).json()
        self.assertEqual(created["launch_dir"], folder)
        self.assertIsNone(created["workspace_dir"])
        listed = {s["id"]: s for s in (await self.client.get("/api/sessions")).json()}
        self.assertEqual(listed[created["id"]]["launch_dir"], folder)
        plain = (await self.client.post("/api/sessions", json={})).json()
        self.assertNotIn("launch_dir", plain)

    async def test_a_bad_folder_is_refused(self):
        for value in ("relative/path", "C:\\ok\nnot"):
            response = await self.client.post("/api/sessions", json={"launch_dir": value})
            self.assertEqual(response.status_code, 400, value)


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
