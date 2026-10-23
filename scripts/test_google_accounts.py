"""Several Google accounts, and models sending email from a chosen account.

Google's HTTP layer, the permission broker and SMTP are mocked; nothing
leaves this machine. Run with the project Python.
"""
import base64
from copy import deepcopy
import email
import json
import os
from pathlib import Path
import sys
import uuid
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

_TEST_PARENT = Path(__file__).resolve().parents[1] / "data"
_TEST_PARENT.mkdir(exist_ok=True)
_DATA = _TEST_PARENT / ("google-accounts-test-" + uuid.uuid4().hex)
_DATA.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(_DATA)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from core import google_workspace as google, email_send, permissions, tool_registry
from core.secret_storage import encrypt
from services.email_service import email_service

REAL_CLIENT = httpx.AsyncClient
CALLBACK = "http://127.0.0.1:8420/api/google/oauth/callback"
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

    async def sign_in(self, address):
        from urllib.parse import parse_qs, urlsplit
        self.sign_in_as = address
        state = parse_qs(urlsplit(google.start_sign_in(CALLBACK)).query)["state"][0]
        return await google.finish_sign_in(state, "code", CALLBACK)


class AccountsTests(GoogleFixture):

    def test_existing_single_account_carries_over_unchanged(self):
        status = google.status()
        self.assertTrue(status["connected"])
        self.assertEqual(status["email"], "chris@school.org")
        self.assertEqual([a["email"] for a in status["accounts"]], ["chris@school.org"])
        self.assertEqual(status["calendar_ids"], ["primary"])
        self.assertTrue(status["calendar_connected"])
        self.assertFalse(status["accounts"][0]["can_send_email"])
        google.set_default("chris@school.org")  # first write persists the new layout
        self.assertNotIn("refresh_token", self.data)
        self.assertEqual(len(self.data["accounts"]), 1)

    async def test_second_account_is_added_without_replacing_the_first(self):
        await self.sign_in("chris.coach@gmail.com")
        status = google.status()
        self.assertEqual({a["email"] for a in status["accounts"]}, {"chris@school.org", "chris.coach@gmail.com"})
        self.assertEqual(status["email"], "chris@school.org")  # Library stays on the account it was on
        await self.sign_in("Chris.Coach@gmail.com")  # same account again: updated, not duplicated
        self.assertEqual(len(google.status()["accounts"]), 2)
        self.assertNotIn("new-refresh", json.dumps(self.data))  # tokens stay encrypted

    async def test_each_account_uses_its_own_token(self):
        await self.sign_in("chris.coach@gmail.com")
        await google.list_files()
        with google.use_account("chris.coach@gmail.com"):
            await google.list_files()
        self.assertEqual(self.calls[0][1], "Bearer refreshed-first-refresh")
        self.assertEqual(self.calls[1][1], "Bearer new-access")
        with self.assertRaises(google.GoogleError) as missing, google.use_account("stranger@example.com"):
            await google.list_files()
        self.assertEqual(missing.exception.status, 404)

    async def test_library_and_calendar_defaults_are_separate_and_disconnect_is_per_account(self):
        await self.sign_in("chris.coach@gmail.com")
        coach = next(a["id"] for a in google.status()["accounts"] if a["email"] == "chris.coach@gmail.com")
        google.set_default(coach)
        status = google.status()
        self.assertEqual(status["email"], "chris.coach@gmail.com")
        self.assertEqual(status["calendar_ids"], ["primary"])  # Calendar still on the school account
        google.disconnect(coach)
        status = google.status()
        self.assertEqual([a["email"] for a in status["accounts"]], ["chris@school.org"])
        self.assertEqual(status["email"], "chris@school.org")
        google.disconnect()
        self.assertFalse(google.status()["connected"])

    async def test_gmail_send_needs_the_send_permission_and_uses_the_chosen_account(self):
        with self.assertRaises(google.GoogleError) as old:
            await google.send_gmail("chris@school.org", ["parent@example.com"], "Hi", "Body")
        self.assertEqual(old.exception.status, 409)
        await self.sign_in("chris.coach@gmail.com")
        result = await google.send_gmail("chris.coach@gmail.com", ["parent@example.com", "aide@example.com"],
                                         "Practice moved", "See you Thursday.", cc=["ad@school.org"], in_reply_to="<m1@x>")
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
        with patch.object(permissions, "decide", decide):
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

    async def test_google_chat_tools_accept_an_account(self):
        await self.call("google_drive", {"action": "list", "account": "chris.coach@gmail.com"})
        self.assertEqual(self.calls[-1][1], "Bearer new-access")
        text, _ = await self.call("google_drive", {"action": "list", "account": "stranger@example.com"})
        self.assertIn("not connected", text)


if __name__ == "__main__":
    unittest.main()
