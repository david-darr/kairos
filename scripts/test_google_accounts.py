"""Several connected Google accounts: listing, adding, switching, disconnecting,
per-user isolation, migration of the one-account file, and token secrecy.

Google's HTTP layer is mocked; no server, subprocess or Google account is used.
Run with the project Python.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

_TEST_PARENT = Path(__file__).resolve().parents[1] / "data"
_TEST_PARENT.mkdir(exist_ok=True)
_DATA = _TEST_PARENT / ("google-accounts-test-" + uuid.uuid4().hex)
_DATA.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(_DATA)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import httpx
from fastapi import FastAPI
from core import google_workspace as google, google_chat_tools, tool_registry
from core.middleware import require_admin
from core.secret_storage import decrypt, encrypt
from routes import google_routes

REAL_CLIENT = httpx.AsyncClient
REDIRECT = "http://127.0.0.1:8420/api/google/oauth/callback"
CLIENT = "fixture.apps.googleusercontent.com"


class AccountTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The one-account file every existing installation has today.
        self.data = {"client_id": CLIENT, "refresh_token": encrypt("refresh-legacy"),
                     "access_token": encrypt("access-legacy"), "expires_at": 9e12,
                     "email": "legacy@example.com", "granted_scopes": list(google.SCOPES),
                     "calendar_ids": ["legacy@example.com"]}
        self.requests = []
        self.next_email = "second@example.com"
        self.refresh_status = 200
        self.rotate = None
        self.userinfo_status = 200
        def save(data):
            self.data = deepcopy(data)
        for mock in (patch.object(google, "_load", lambda: deepcopy(self.data)), patch.object(google, "_save", save),
                     patch.object(google.httpx, "AsyncClient",
                                  lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(self.http), **kwargs))):
            mock.start()
            self.addCleanup(mock.stop)
        google._pending.clear()
        google.invalidate_calendar()

    def http(self, req):
        self.requests.append(req)
        if req.url.host == "oauth2.googleapis.com":
            form = parse_qs(req.content.decode())
            if form["grant_type"] == ["refresh_token"]:
                if self.refresh_status >= 400:
                    return httpx.Response(self.refresh_status, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "fresh-" + form["refresh_token"][0], "expires_in": 3600,
                                                 **({"refresh_token": self.rotate} if self.rotate else {})})
            email = self.next_email
            return httpx.Response(200, json={"refresh_token": "refresh-" + email, "access_token": "access-" + email,
                                             "scope": " ".join(google.SCOPES)})
        if req.url.host == "openidconnect.googleapis.com":
            if self.userinfo_status != 200:
                return httpx.Response(self.userinfo_status, json={})
            return httpx.Response(200, json={"email": req.headers["authorization"].removeprefix("Bearer access-")})
        if req.url.path.endswith("/files"):
            return httpx.Response(200, json={"files": [{"id": "f1", "name": req.headers["authorization"]}]})
        if req.url.path.endswith("/about"):
            return httpx.Response(200, json={"storageQuota": {"usage": "1", "limit": "2"}})
        if "/calendar/v3/" in req.url.path:
            return httpx.Response(200, json={"items": []})
        raise AssertionError(f"Unexpected Google HTTP request: {req.method} {req.url}")

    async def web(self, path, method="GET", body=None, user="admin"):
        app = FastAPI()
        app.include_router(google_routes.router)
        app.dependency_overrides[require_admin] = lambda: user
        async with REAL_CLIENT(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.request(method, path, json=body)

    async def sign_in(self, email, user="admin", add=True, account=None):
        self.next_email = email
        with patch.object(google_routes, "local_api_base", lambda: "http://127.0.0.1:8420/api"):
            started = await self.web("/api/google/oauth/start", "POST", {"add": add, "account": account}, user=user)
        self.assertEqual(started.status_code, 200, started.text)
        state = parse_qs(urlsplit(started.json()["url"]).query)["state"][0]
        return await self.web(f"/api/google/oauth/callback?state={state}&code=code")

    async def add_account(self, email, user="admin", add=True, account=None):
        result = await self.sign_in(email, user, add, account)
        self.assertEqual(result.status_code, 200, result.text)
        if account:
            return account
        return next(item["id"] for item in google._accounts(self.data) if item["email"] == email and item.get("owner") == user)

    def bearer(self):
        return [req.headers["authorization"] for req in self.requests if req.url.host == "www.googleapis.com"][-1]

    async def test_calendar_reconnect_refreshes_its_account_in_place(self):
        legacy = google.resolve_account("admin")
        status = (await self.web("/api/google/status", user="bob")).json()
        self.assertEqual(status["calendar_account"], legacy)
        before = len(self.data["accounts"])
        await self.add_account("legacy@example.com", user="bob", add=False, account=status["calendar_account"])
        self.assertEqual(len(self.data["accounts"]), before)
        self.assertEqual(self.data["default_account"], legacy)
        self.assertIsNone(self.data["accounts"][legacy]["owner"])
        # A user-owned Calendar account is never offered to another user to reconnect.
        await self.add_account("alice@example.com", user="alice", add=False)
        self.assertIsNone((await self.web("/api/google/status", user="bob")).json()["calendar_account"])

    async def test_existing_account_migrates_as_the_default(self):
        status = (await self.web("/api/google/status")).json()
        self.assertTrue(status["connected"])
        self.assertEqual(status["email"], "legacy@example.com")
        self.assertEqual([item["email"] for item in status["accounts"]], ["legacy@example.com"])
        legacy = status["accounts"][0]["id"]
        self.assertEqual((status["default_account"], status["accounts"][0]["default"]), (legacy, True))
        self.assertNotIn("refresh_token", self.data)
        account = self.data["accounts"][legacy]
        self.assertEqual((account["owner"], self.data["default_account"]), (None, legacy))
        self.assertEqual(decrypt(account["refresh_token"]), "refresh-legacy")
        self.assertEqual(account["calendar_ids"], ["legacy@example.com"])
        self.assertTrue(status["calendar_connected"])
        self.assertEqual(status["calendar_ids"], ["legacy@example.com"])
        # Every admin keeps the access they had, and requests without an account use it.
        self.assertEqual([item["id"] for item in (await self.web("/api/google/status", user="other-admin")).json()["accounts"]], [legacy])
        await self.web("/api/google/drive/files?section=my_drive")
        self.assertEqual(self.bearer(), "Bearer access-legacy")
        # Migration happens once; a second read keeps the same id.
        self.assertEqual((await self.web("/api/google/status")).json()["default_account"], legacy)

    async def test_adding_listing_and_switching_between_accounts(self):
        legacy = google.resolve_account("admin")
        second = await self.add_account("second@example.com")
        status = (await self.web("/api/google/status")).json()
        self.assertEqual([(item["email"], item["default"]) for item in status["accounts"]],
                         [("legacy@example.com", True), ("second@example.com", False)])
        # Adding a Drive keeps Calendar on the account it already used.
        self.assertEqual(self.data["default_account"], legacy)
        self.assertEqual(status["calendar_ids"], ["legacy@example.com"])
        self.assertEqual(self.data["accounts"][second]["owner"], "admin")
        await self.web(f"/api/google/drive/files?section=my_drive&account={second}")
        self.assertEqual(self.bearer(), "Bearer access-second@example.com")
        await self.web(f"/api/google/drive/storage?account={legacy}")
        self.assertEqual(self.bearer(), "Bearer access-legacy")
        await self.web(f"/api/google/drive/action?account={second}", "POST", {"action": "create_folder", "name": "New"})
        self.assertEqual(self.bearer(), "Bearer access-second@example.com")
        # Signing in to the same account again reconnects it instead of adding a duplicate.
        self.assertEqual(await self.add_account("second@example.com"), second)
        self.assertEqual(len(self.data["accounts"]), 2)

    async def test_connecting_without_add_makes_the_account_the_default(self):
        third = await self.add_account("third@example.com", add=False)
        self.assertEqual(self.data["default_account"], third)
        self.assertEqual((await self.web("/api/google/status")).json()["email"], "third@example.com")

    async def test_disconnecting_one_account_keeps_the_others(self):
        legacy = google.resolve_account("admin")
        second = await self.add_account("second@example.com")
        status = (await self.web(f"/api/google/accounts/{second}", "DELETE")).json()
        self.assertEqual([item["id"] for item in status["accounts"]], [legacy])
        self.assertEqual(self.data["default_account"], legacy)
        self.assertNotIn(second, self.data["accounts"])
        # Disconnecting the default hands Calendar and chat to the oldest remaining account.
        second = await self.add_account("second@example.com")
        status = (await self.web(f"/api/google/accounts/{legacy}", "DELETE")).json()
        self.assertEqual((status["default_account"], self.data["default_account"]), (second, second))
        self.assertTrue(status["connected"])
        status = (await self.web("/api/google/connection", "DELETE")).json()
        self.assertFalse(status["connected"])
        self.assertEqual(status["accounts"], [])
        self.assertIsNone(self.data["default_account"])

    async def test_another_users_account_cannot_be_used_or_removed(self):
        mine = await self.add_account("mine@example.com", user="alice")
        for method, path in (("GET", f"/api/google/drive/files?account={mine}"), ("GET", f"/api/google/drive/storage?account={mine}"),
                             ("GET", f"/api/google/drive/files/f1/download?account={mine}"), ("GET", f"/api/google/sheets/f1?account={mine}"),
                             ("POST", f"/api/google/drive/action?account={mine}"), ("DELETE", f"/api/google/accounts/{mine}"),
                             ("GET", "/api/google/drive/files?account=acct_made-up"), ("GET", "/api/google/drive/files?account=../x")):
            self.requests.clear()
            body = {"action": "trash", "file_id": "f1"} if method == "POST" else None
            response = await self.web(path, method, body, user="bob")
            self.assertEqual(response.status_code, 404, path)
            self.assertEqual(response.json()["detail"], "Unknown Google account")
            self.assertFalse(self.requests, "no token was used for " + path)
        self.assertIn(mine, self.data["accounts"])
        self.assertNotIn(mine, [item["id"] for item in (await self.web("/api/google/status", user="bob")).json()["accounts"]])
        self.assertIn(mine, [item["id"] for item in (await self.web("/api/google/status", user="alice")).json()["accounts"]])
        # Alice's own requests reach her account.
        await self.web(f"/api/google/drive/files?account={mine}", user="alice")
        self.assertEqual(self.bearer(), "Bearer access-mine@example.com")

    async def test_tokens_never_reach_the_client(self):
        second = await self.add_account("second@example.com")
        self.refresh_status = 400
        self.data["accounts"][second]["expires_at"] = 0
        await self.web(f"/api/google/drive/files?account={second}")
        secrets = ["refresh-legacy", "access-legacy", "refresh-second@example.com", "access-second@example.com"]
        secrets += [account[key] for account in self.data["accounts"].values() for key in ("refresh_token", "access_token") if account.get(key)]
        for path, method in (("/api/google/status", "GET"), (f"/api/google/accounts/{second}", "DELETE")):
            text = (await self.web(path, method)).text
            for secret in secrets:
                self.assertNotIn(secret, text, path)
            for key in ("refresh_token", "access_token", "client_secret", "owner"):
                self.assertNotIn(key, text, path)
        callback = google.start_sign_in(REDIRECT, "admin", add=True)
        self.assertNotIn("refresh", callback)

    async def test_an_expired_account_shows_its_error_alone(self):
        legacy = google.resolve_account("admin")
        second = await self.add_account("second@example.com")
        self.data["accounts"][second]["expires_at"] = 0
        self.refresh_status = 400
        response = await self.web(f"/api/google/drive/files?account={second}")
        self.assertEqual(response.status_code, 401)
        accounts = {item["id"]: item for item in (await self.web("/api/google/status")).json()["accounts"]}
        self.assertIn("Reconnect", accounts[second]["error"])
        self.assertIsNone(accounts[legacy]["error"])
        self.refresh_status = 200
        self.assertEqual((await self.web(f"/api/google/drive/files?account={legacy}")).status_code, 200)
        # Reconnecting clears the error.
        await self.add_account("second@example.com")
        self.assertIsNone(next(item for item in (await self.web("/api/google/status")).json()["accounts"] if item["id"] == second)["error"])

    async def test_sign_in_state_is_single_use_and_bound_to_its_user(self):
        url = google.start_sign_in(REDIRECT, "alice", add=True)
        state = parse_qs(urlsplit(url).query)["state"][0]
        self.next_email = "alice@example.com"
        for bad in ("", "forged", state + "x"):
            response = await self.web(f"/api/google/oauth/callback?state={bad}&code=code")
            self.assertEqual(response.status_code, 400)
        self.assertEqual((await self.web(f"/api/google/oauth/callback?state={state}&code=code")).status_code, 200)
        self.assertEqual((await self.web(f"/api/google/oauth/callback?state={state}&code=code")).status_code, 400)
        added = next(item for item in self.data["accounts"].values() if item["email"] == "alice@example.com")
        self.assertEqual(added["owner"], "alice")
        late = parse_qs(urlsplit(google.start_sign_in(REDIRECT, "alice")).query)["state"][0]
        with patch.object(google.time, "time", return_value=google.time.time() + 601):
            self.assertEqual((await self.web(f"/api/google/oauth/callback?state={late}&code=code")).status_code, 400)
        self.assertIn("select_account", parse_qs(urlsplit(url).query)["prompt"][0])

    async def test_calendar_keeps_using_the_default_account(self):
        second = await self.add_account("second@example.com")
        await google.calendar_list()
        self.assertEqual(self.bearer(), "Bearer access-legacy")
        google.calendar_settings(["legacy@example.com", "team@example.com"])
        self.assertEqual(self.data["accounts"][self.data["default_account"]]["calendar_ids"], ["legacy@example.com", "team@example.com"])
        self.assertNotIn("calendar_ids", self.data["accounts"][second])

    async def chat(self, owner, action="list"):
        ctx = tool_registry.ToolContext(session_id="session", is_admin=True)
        with patch.object(google_chat_tools, "chat_owner", lambda _ctx: owner):
            return await google_chat_tools.execute("drive", {"action": action}, ctx)

    async def test_chat_tools_use_the_chat_owners_account_never_another_users(self):
        alice = await self.add_account("alice@example.com", user="alice", add=False)
        self.assertEqual(self.data["default_account"], alice)
        # Bob's chat reaches the shared migrated account, not Alice's default.
        await self.chat("bob")
        self.assertEqual(self.bearer(), "Bearer access-legacy")
        await self.chat("alice")
        self.assertEqual(self.bearer(), "Bearer access-alice@example.com")
        legacy = next(item["id"] for item in google._accounts(self.data) if item["owner"] is None)
        await self.web(f"/api/google/accounts/{legacy}", "DELETE", user="bob")
        self.requests.clear()
        self.assertIn("Connect Google Workspace", await self.chat("bob"))
        self.assertIn("belongs to a Kairos user", await self.chat(None))
        self.assertFalse(self.requests)

    async def test_disconnecting_the_default_never_hands_calendar_to_another_users_account(self):
        legacy = google.resolve_account("admin")
        await self.add_account("alice@example.com", user="alice")
        status = (await self.web(f"/api/google/accounts/{legacy}", "DELETE", user="bob")).json()
        self.assertIsNone(self.data["default_account"])
        self.assertFalse(status["connected"])
        self.assertFalse(google.status()["calendar_connected"])

    async def test_reconnect_by_email_only_matches_the_users_own_account(self):
        legacy = google.resolve_account("admin")
        self.data["accounts"][legacy]["error"] = "expired"
        mine = await self.add_account("legacy@example.com", user="bob")
        self.assertNotEqual(mine, legacy)
        self.assertEqual(self.data["accounts"][mine]["owner"], "bob")
        self.assertEqual(decrypt(self.data["accounts"][legacy]["refresh_token"]), "refresh-legacy")
        self.assertEqual(self.data["accounts"][legacy]["error"], "expired")
        # Named explicitly from its card, the shared account is reconnected in place.
        self.assertEqual(await self.add_account("legacy@example.com", user="bob", account=legacy), legacy)
        self.assertEqual(decrypt(self.data["accounts"][legacy]["refresh_token"]), "refresh-legacy@example.com")
        self.assertNotIn("error", self.data["accounts"][legacy])
        self.assertIsNone(self.data["accounts"][legacy]["owner"])
        # Signing in as a different email does not overwrite it or add an account.
        result = await self.sign_in("someone@example.com", user="bob", account=legacy)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(self.data["accounts"][legacy]["email"], "legacy@example.com")
        self.assertFalse(any(item["email"] == "someone@example.com" for item in self.data["accounts"].values()))
        # Another user's account cannot be named.
        alice = await self.add_account("alice@example.com", user="alice")
        with patch.object(google_routes, "local_api_base", lambda: "http://127.0.0.1:8420/api"):
            self.assertEqual((await self.web("/api/google/oauth/start", "POST", {"account": alice}, user="bob")).status_code, 404)

    async def test_disconnect_is_idempotent_and_checks_ownership_itself(self):
        alice = await self.add_account("alice@example.com", user="alice")
        legacy = next(item["id"] for item in google._accounts(self.data) if item["owner"] is None)
        await self.web(f"/api/google/accounts/{legacy}", "DELETE", user="carol")
        response = await self.web("/api/google/connection", "DELETE", user="carol")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accounts"], [])
        self.assertIn(alice, self.data["accounts"])
        # A direct caller cannot remove someone else's account either.
        with self.assertRaises(google.GoogleError):
            google.disconnect(alice, "carol")
        self.assertIn(alice, self.data["accounts"])

    async def test_a_client_change_during_sign_in_saves_nothing(self):
        url = google.start_sign_in(REDIRECT, "admin", add=True)
        state = parse_qs(urlsplit(url).query)["state"][0]
        before = deepcopy(google._state()["accounts"])
        self.data["client_id"] = "other.apps.googleusercontent.com"
        self.next_email = "late@example.com"
        response = await self.web(f"/api/google/oauth/callback?state={state}&code=code")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.data["accounts"], before)
        # Changing the client through configure also cancels started sign-ins.
        self.data["client_id"] = CLIENT
        state = parse_qs(urlsplit(google.start_sign_in(REDIRECT, "admin")).query)["state"][0]
        google.configure("third.apps.googleusercontent.com")
        self.assertEqual((await self.web(f"/api/google/oauth/callback?state={state}&code=code")).status_code, 400)

    async def test_rotated_refresh_token_is_saved_and_waiters_reuse_a_fresh_token(self):
        second = await self.add_account("second@example.com")
        self.data["accounts"][second]["expires_at"] = 0
        self.rotate = "rotated-refresh"
        await self.web(f"/api/google/drive/files?account={second}")
        self.assertEqual(decrypt(self.data["accounts"][second]["refresh_token"]), "rotated-refresh")
        self.rotate = None
        self.requests.clear()
        async def slow(req):  # the second caller waits on the lock while the first refreshes
            await asyncio.sleep(0.05)
            return self.http(req)
        with patch.object(google.httpx, "AsyncClient", lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(slow), **kwargs)):
            await asyncio.gather(google._token(second, force=True), google._token(second, force=True))
        self.assertEqual(sum(req.url.host == "oauth2.googleapis.com" for req in self.requests), 1)

    async def test_sign_in_without_an_email_is_refused(self):
        self.userinfo_status = 500
        before = len(google._accounts(google._state()))
        response = await self.sign_in("ghost@example.com")
        self.assertEqual(response.status_code, 502)
        self.assertIn("email", response.text)
        self.assertEqual(len(google._accounts(self.data)), before)

    async def test_changing_the_client_forgets_every_account(self):
        await self.add_account("second@example.com")
        status = google.configure("other.apps.googleusercontent.com")
        self.assertFalse(status["connected"])
        self.assertNotIn("accounts", self.data)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        shutil.rmtree(_DATA)
