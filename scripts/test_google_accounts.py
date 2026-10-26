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

import base64
import email
from types import SimpleNamespace
from unittest.mock import AsyncMock
from core import email_send, permissions
from services.email_service import email_service

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


    async def test_dev_multi_account_migration_preserves_tokens_and_both_defaults(self):
        first = {"email": "school@example.com", "refresh_token": encrypt("school-refresh"),
                 "granted_scopes": list(google.SCOPES), "calendar_ids": ["primary"]}
        second = {"email": "coach@example.com", "refresh_token": encrypt("coach-refresh"),
                  "granted_scopes": list(google.SCOPES), "calendar_ids": []}
        self.data = {"client_id": CLIENT, "accounts": {"hash-school": first, "hash-coach": second},
                     "active_account": "hash-coach", "calendar_account": "hash-school"}
        status = google.status("admin")
        self.assertEqual(status["email"], "coach@example.com")
        self.assertEqual(status["calendar_ids"], ["primary"])
        accounts = self.data["accounts"]
        self.assertEqual(len(accounts), 2)
        self.assertTrue(all(k.startswith("acct_") and a["id"] == k and a["owner"] is None for k, a in accounts.items()))
        self.assertEqual({decrypt(a["refresh_token"]) for a in accounts.values()}, {"school-refresh", "coach-refresh"})
        before = deepcopy(self.data)
        google.status("admin")
        self.assertEqual(self.data, before)

    async def test_calendar_and_default_routes_refuse_foreign_accounts_before_http(self):
        alice = await self.add_account("alice@example.com", user="alice", add=False)
        bob = await self.add_account("bob@example.com", user="bob")
        self.requests.clear()
        self.assertFalse(google.status("bob")["calendar_connected"])
        self.assertIsNone(google.status("bob")["calendar_ids"])
        for path in ("/api/google/calendar/calendars", "/api/google/calendar/events?start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z"):
            self.assertEqual((await self.web(path, user="bob")).status_code, 404)
        self.assertEqual((await self.web("/api/google/accounts/default", "POST", {"account": alice, "purpose": "calendar"}, user="bob")).status_code, 404)
        self.assertFalse(self.requests)
        self.assertEqual((await self.web("/api/google/accounts/default", "POST", {"account": bob, "purpose": "calendar"}, user="bob")).status_code, 200)
        self.assertEqual(google.status("bob")["calendar_account"], bob)
        await self.web("/api/google/calendar/calendars", user="bob")
        self.assertEqual(self.bearer(), "Bearer access-bob@example.com")
        self.assertEqual(google.status("alice")["calendar_account"], alice)

    async def test_foreign_gmail_account_is_refused_before_scope_or_token_use(self):
        alice = await self.add_account("alice@example.com", user="alice")
        self.requests.clear()
        for wanted in (alice, "alice@example.com"):
            with self.assertRaises(google.GoogleError) as refusal:
                await google.send_gmail(wanted, ["to@example.com"], "Hi", "Body", user="bob")
            self.assertEqual(refusal.exception.status, 404)
        self.assertFalse(self.requests)



ALL = list(google.SCOPES)
NO_SEND = [s for s in google.SCOPES if s != google.GMAIL_SEND_SCOPE]


class GoogleFixture(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The pre-existing single-account layout, as installs store it today.
        self.data = {"client_id": "fixture.apps.googleusercontent.com", "refresh_token": encrypt("first-refresh"),
                     "email": "chris@school.org", "granted_scopes": NO_SEND, "calendar_ids": ["primary"]}
        self.sign_in_as = None
        self.calls = []
        def save(data):
            self.data = deepcopy(data)
        for change in (patch.object(google, "_load", lambda: deepcopy(self.data)), patch.object(google, "_save", save),
                       patch.object(google.httpx, "AsyncClient",
                                    lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(self.http), **kw))):
            change.start(); self.addCleanup(change.stop)
        google.invalidate_calendar()

    def http(self, request):
        url = str(request.url)
        if url == google.TOKEN_URL:
            body = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            if body["grant_type"] == "authorization_code":
                return httpx.Response(200, json={"access_token": "new-access", "refresh_token": "new-refresh",
                                                 "expires_in": 3600, "scope": " ".join(ALL)})
            return httpx.Response(200, json={"access_token": "refreshed-" + body["refresh_token"], "expires_in": 3600})
        if url.startswith("https://openidconnect.googleapis.com"):
            return httpx.Response(200, json={"email": self.sign_in_as})
        self.calls.append((url, request.headers["authorization"], request.content))
        if "/gmail/" in url:
            return httpx.Response(200, json={"id": "gmail-1", "threadId": "thread-1"})
        return httpx.Response(200, json={"files": []})

    async def sign_in(self, address, user="fixture"):
        from urllib.parse import parse_qs, urlsplit
        self.sign_in_as = address
        state = parse_qs(urlsplit(google.start_sign_in(REDIRECT, user, add=True)).query)["state"][0]
        return await google.finish_sign_in(state, "code", REDIRECT)


class AccountsTests(GoogleFixture):

    def test_existing_single_account_carries_over_unchanged(self):
        status = google.status("fixture")
        self.assertTrue(status["connected"])
        self.assertEqual(status["email"], "chris@school.org")
        self.assertEqual([a["email"] for a in status["accounts"]], ["chris@school.org"])
        self.assertEqual(status["calendar_ids"], ["primary"])
        self.assertTrue(status["calendar_connected"])
        self.assertFalse(status["accounts"][0]["can_send_email"])
        google.set_default("chris@school.org", user="fixture")  # first write persists the new layout
        self.assertNotIn("refresh_token", self.data)
        self.assertEqual(len(self.data["accounts"]), 1)

    async def test_second_account_is_added_without_replacing_the_first(self):
        await self.sign_in("chris.coach@gmail.com")
        status = google.status("fixture")
        self.assertEqual({a["email"] for a in status["accounts"]}, {"chris@school.org", "chris.coach@gmail.com"})
        self.assertEqual(status["email"], "chris@school.org")  # Library stays on the account it was on
        await self.sign_in("Chris.Coach@gmail.com")  # same account again: updated, not duplicated
        self.assertEqual(len(google.status("fixture")["accounts"]), 2)
        self.assertNotIn("new-refresh", json.dumps(self.data))  # tokens stay encrypted

    async def test_each_account_uses_its_own_token(self):
        await self.sign_in("chris.coach@gmail.com")
        await google.list_files()
        with google.use_account("chris.coach@gmail.com", "fixture"):
            await google.list_files()
        self.assertEqual(self.calls[0][1], "Bearer refreshed-first-refresh")
        self.assertEqual(self.calls[1][1], "Bearer new-access")
        with self.assertRaises(google.GoogleError) as missing, google.use_account("stranger@example.com", "fixture"):
            await google.list_files()
        self.assertEqual(missing.exception.status, 404)

    async def test_library_and_calendar_defaults_are_separate_and_disconnect_is_per_account(self):
        await self.sign_in("chris.coach@gmail.com")
        coach = next(a["id"] for a in google.status("fixture")["accounts"] if a["email"] == "chris.coach@gmail.com")
        google.set_default(coach, user="fixture")
        status = google.status("fixture")
        self.assertEqual(status["email"], "chris.coach@gmail.com")
        self.assertEqual(status["calendar_ids"], ["primary"])  # Calendar still on the school account
        google.disconnect(coach, "fixture")
        status = google.status("fixture")
        self.assertEqual([a["email"] for a in status["accounts"]], ["chris@school.org"])
        self.assertEqual(status["email"], "chris@school.org")
        google.disconnect(user="fixture")
        self.assertFalse(google.status("fixture")["connected"])

    async def test_gmail_send_needs_the_send_permission_and_uses_the_chosen_account(self):
        with self.assertRaises(google.GoogleError) as old:
            await google.send_gmail("chris@school.org", ["parent@example.com"], "Hi", "Body", user="fixture")
        self.assertEqual(old.exception.status, 409)
        await self.sign_in("chris.coach@gmail.com")
        result = await google.send_gmail("chris.coach@gmail.com", ["parent@example.com", "aide@example.com"],
                                         "Practice moved", "See you Thursday.", cc=["ad@school.org"], in_reply_to="<m1@x>", user="fixture")
        self.assertEqual(result, {"id": "gmail-1", "thread_id": "thread-1", "from": "chris.coach@gmail.com"})
        url, auth, content = self.calls[-1]
        self.assertTrue(url.endswith("/gmail/v1/users/me/messages/send"))
        self.assertEqual(auth, "Bearer new-access")
        sent = email.message_from_bytes(base64.urlsafe_b64decode(json.loads(content)["raw"]))
        self.assertEqual(sent["From"], "chris.coach@gmail.com")
        self.assertEqual(sent["To"], "parent@example.com, aide@example.com")
        self.assertEqual(sent["Cc"], "ad@school.org")
        self.assertEqual(sent["In-Reply-To"], "<m1@x>")
        self.assertIn("See you Thursday.", sent.get_payload())


class SendToolTests(GoogleFixture):
    async def asyncSetUp(self):
        await self.sign_in("chris.coach@gmail.com")
        self.smtp = []
        for change in (patch.object(email_service, "list_accounts",
                                    return_value=[{"id": "smtp1", "email": "office@club.org"}]),
                       patch.object(email_service, "send_message", side_effect=lambda *a, **kw: self.smtp.append((a, kw)))):
            change.start(); self.addCleanup(change.stop)

    async def call(self, name, args, behavior="allow", ctx=None):
        decide = AsyncMock(return_value=SimpleNamespace(behavior=behavior, reason=None if behavior == "allow" else "rejected"))
        with patch.object(permissions, "decide", decide), patch.object(tool_registry, "_tab_task_owner", return_value="fixture"), patch.object(google_chat_tools, "chat_owner", return_value="fixture"):
            text = await tool_registry.call(name, args, ctx or tool_registry.ToolContext(session_id="chat", is_admin=True),
                                            tool_registry.CODEX)
        return str(getattr(text, "text", text)), decide

    async def test_lists_every_sending_address(self):
        text, _ = await self.call("list_email_accounts", {})
        self.assertIn("chris.coach@gmail.com (Google)", text)
        self.assertIn("office@club.org (Email tab)", text)
        self.assertIn("chris@school.org (Google; reconnect it in Library", text)

    async def test_sends_from_the_named_google_account_after_approval(self):
        args = {"from_account": "chris.coach@gmail.com", "to": "parent@example.com", "subject": "Practice", "body": "Moved to 5pm."}
        text, decide = await self.call("send_email", args)
        self.assertIn("Sent from chris.coach@gmail.com to parent@example.com", text)
        self.assertEqual(decide.await_args.kwargs["target"], "chris.coach@gmail.com")
        self.assertIn("parent@example.com", decide.await_args.kwargs["description"])
        self.assertTrue(self.calls[-1][0].endswith("/messages/send"))

    async def test_sends_from_an_email_tab_account_over_smtp(self):
        args = {"from_account": "office@club.org", "to": "a@example.com, b@example.com", "cc": "c@example.com",
                "subject": "Schedule", "body": "Attached below."}
        text, _ = await self.call("send_email", args)
        self.assertIn("Sent from office@club.org", text)
        (account_id, to, subject, body), kw = self.smtp[-1]
        self.assertEqual((account_id, to, kw["cc"]), ("smtp1", "a@example.com, b@example.com", "c@example.com"))

    async def test_rejected_unknown_unready_or_unsafe_sends_never_go_out(self):
        base = {"from_account": "chris.coach@gmail.com", "to": "parent@example.com", "subject": "Hi", "body": "Body"}
        before = len(self.calls)
        text, _ = await self.call("send_email", base, behavior="deny")
        self.assertIn("Not sent", text)
        for change, reason in (({"from_account": "someone@else.com"}, "not a connected account"),
                               ({"from_account": "chris@school.org"}, "cannot send yet"),
                               ({"to": "x@example.com\r\nBcc: all@example.com"}, "Invalid"),
                               ({"subject": "Hi\r\nBcc: all@example.com"}, "Invalid"),
                               ({"to": "not-an-address"}, "not a valid"),
                               ({"body": " "}, "1 to 50,000")):
            text, decide = await self.call("send_email", {**base, **change})
            self.assertIn(reason, text)
            decide.assert_not_awaited()
        self.assertEqual(len(self.calls), before)
        self.assertFalse(self.smtp)

    async def test_send_tools_are_admin_only_and_not_in_read_only_chats(self):
        names = {s.name for s in tool_registry.specs(tool_registry.CODEX, is_admin=False)}
        self.assertFalse({"send_email", "list_email_accounts"} & names)
        names = {s.name for s in tool_registry.specs(tool_registry.CODEX, is_admin=True, read_only=True)}
        self.assertNotIn("send_email", names)

    async def test_email_tab_lists_sending_accounts_for_admins_only(self):
        from fastapi import FastAPI, HTTPException
        from core.middleware import require_admin
        from routes import email_routes
        app = FastAPI()
        app.include_router(email_routes.router)
        async def get(admin):
            def identity():
                if not admin:
                    raise HTTPException(403, "admin privileges required")
                return "fixture"
            app.dependency_overrides[require_admin] = identity
            async with REAL_CLIENT(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/api/email/sending-accounts")
        result = (await get(True)).json()
        self.assertTrue(result["google_configured"])
        self.assertEqual({(a["email"], a["via"], a["can_send"]) for a in result["accounts"]},
                         {("chris@school.org", "Google", False), ("chris.coach@gmail.com", "Google", True),
                          ("office@club.org", "Email tab", True)})
        self.assertNotIn("refresh_token", json.dumps(result))
        self.assertEqual((await get(False)).status_code, 403)

    async def test_google_chat_tools_accept_an_account(self):
        await self.call("google_drive", {"action": "list", "account": "chris.coach@gmail.com"})
        self.assertEqual(self.calls[-1][1], "Bearer new-access")
        text, _ = await self.call("google_drive", {"action": "list", "account": "stranger@example.com"})
        self.assertIn("Unknown Google account", text)

    async def test_real_agent_owner_scopes_listing_validation_and_send(self):
        from core import auth
        await self.sign_in("alice@example.com", user="alice")
        ctx = tool_registry.ToolContext(agent_id="scout", owner_user="fixture", is_admin=True)
        decide = AsyncMock(return_value=SimpleNamespace(behavior="allow"))
        async def call(name, args):
            return await tool_registry.call(name, args, ctx, tool_registry.CODEX)
        with patch.object(auth, "auth_enabled", return_value=True), patch.object(permissions, "decide", decide):
            listed = await call("list_email_accounts", {})
            self.assertIn("chris.coach@gmail.com", listed)
            self.assertNotIn("alice@example.com", listed)
            args = {"from_account": "alice@example.com", "to": "to@example.com", "subject": "Hi", "body": "Body", "owner": "alice"}
            before = len(self.calls)
            self.assertIn("not a connected account", await call("send_email", args))
            decide.assert_not_awaited()
            self.assertEqual(len(self.calls), before)
            self.assertIn("Sent from chris.coach@gmail.com", await call("send_email", {**args, "from_account": "chris.coach@gmail.com"}))
            self.assertEqual(decide.await_args.kwargs["surface"], "agent:scout")
            self.assertEqual(decide.await_args.kwargs["target"], "chris.coach@gmail.com")
            unknown = tool_registry.ToolContext(agent_id="scout", is_admin=True)
            self.assertIn("must belong", await tool_registry.call("send_email", args, unknown, tool_registry.CODEX))
            self.assertNotIn("chris.coach@gmail.com", await tool_registry.call("list_email_accounts", {}, unknown, tool_registry.CODEX))

    async def test_real_chat_owner_overrides_model_and_context_owner_claims(self):
        from core import auth
        from core.session_manager import session_manager
        ctx = tool_registry.ToolContext(session_id="owned-chat", owner_user="alice", is_admin=True)
        with patch.object(auth, "auth_enabled", return_value=True), patch.object(session_manager, "get_session", return_value={"owner_user": "fixture"}):
            listed = await tool_registry.call("list_email_accounts", {"owner": "alice"}, ctx, tool_registry.CODEX)
        self.assertIn("chris.coach@gmail.com", listed)

    async def test_send_rechecks_ownership_after_approval_and_preserves_taint_gate(self):
        from core import auth
        from core.turn_taint import TurnTaint
        ctx = tool_registry.ToolContext(agent_id="scout", owner_user="fixture", is_admin=True, turn_taint=TurnTaint())
        ctx.turn_taint.mark("Untrusted email")
        async def approve(**kwargs):
            self.assertTrue(kwargs["force_prompt"])
            self.assertEqual(kwargs["surface"], "agent:scout")
            account = next(a for a in self.data["accounts"].values() if a["email"] == "chris.coach@gmail.com")
            account["owner"] = "alice"
            return SimpleNamespace(behavior="allow")
        before = len(self.calls)
        with patch.object(auth, "auth_enabled", return_value=True), patch.object(permissions, "decide", side_effect=approve):
            text = await tool_registry.call("send_email", {"from_account": "chris.coach@gmail.com", "to": "to@example.com", "subject": "Hi", "body": "Body"}, ctx, tool_registry.CODEX)
        self.assertIn("Not sent: Unknown Google account", text)
        self.assertEqual(len(self.calls), before)

    async def test_new_agent_chat_records_the_request_owner(self):
        from routes import agent_routes
        from core.session_manager import session_manager
        agent = {"id": "scout", "name": "Scout"}
        with patch.object(agent_routes, "_require", return_value=agent), patch.object(agent_routes.agent_service, "chat_endpoint", return_value="model"), patch.object(agent_routes.agent_service, "make_agent_chat", side_effect=lambda ident, agent: session_manager.get_session(ident)):
            session = await agent_routes.start_chat("scout", "fixture")
        try:
            self.assertEqual(session["owner_user"], "fixture")
        finally:
            session_manager.delete_session(session["id"])

    async def test_calendar_aggregation_uses_the_real_owner_selection(self):
        from core import auth
        from routes import calendar_routes
        await self.sign_in("alice@example.com", user="alice")
        mine = google.resolve_account("fixture", "chris.coach@gmail.com")
        google.set_default(mine, "calendar", "fixture")
        seen = []
        async def selected(start, end):
            seen.append(google._account.get())
            return []
        with patch.object(auth, "auth_enabled", return_value=True), patch.object(calendar_routes.auth_manager, "is_admin", return_value=True), patch.object(calendar_routes.calendar_service, "list_range", return_value=[]), patch("core.tab_hooks.calendar_items", AsyncMock(return_value=[])), patch.object(google, "selected_calendar_events", side_effect=selected), patch.object(tool_registry.memory_tools, "list_upcoming_events", return_value=[]):
            await calendar_routes.list_events("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", "fixture")
            await tool_registry._list_upcoming_events({}, tool_registry.ToolContext(is_admin=True, owner_user="fixture"))
        self.assertEqual(seen, [mine, mine])
        self.assertIsNone(google._account.get())



if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        from core import session_manager_store
        session_manager_store.close()
        shutil.rmtree(_DATA)
