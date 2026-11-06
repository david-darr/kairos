"""Permission answers keep their exact scope and owner, through the real routes.

test_permissions.py proves the broker's once/session/forever/reject/revoke
rules. This file adds what that suite leaves open: a different member cannot
answer someone else's prompt, two answers sent at once settle on exactly one,
an unknown choice or an extra `scope` field cannot widen a grant, an expired
request cannot be answered late, and a non-chat prompt is an admin's to answer.
Real accounts and cookies (core.auth), real chat sessions, the real app.

    .venv\\Scripts\\python.exe scripts\\test_permissions_scope.py
"""
import asyncio
import logging
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tempfile

_DATA = tempfile.TemporaryDirectory(prefix="g7-permscope-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

import httpx
from unittest.mock import patch

from app import app
from core import permissions
from core.auth import SESSION_COOKIE_NAME, auth_manager
from core.session_manager import session_manager

logging.disable(logging.CRITICAL)


class PermissionScope(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        for name, admin in (("alice", False), ("bob", False), ("boss", True)):
            auth_manager.create_user(name, name + "-password-1", is_admin=admin)
        self.cookie = {u: {"Cookie": f"{SESSION_COOKIE_NAME}={auth_manager.create_session(u)}"} for u in ("alice", "bob", "boss")}
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        # Each test starts with an empty rule file; a standing grant from one must not answer the next.
        rules = patch.object(permissions, "PERMISSIONS_FILE", os.path.join(_DATA.name, f"permissions-{self.id()}.json"))
        rules.start(); self.addCleanup(rules.stop)
        permissions._session_rules.clear(); permissions._channels.clear(); permissions._pending.clear()
        # Alice's chat lives in Alice's account (Multi-Account group 3: every account has its own chats).
        from core import accounts
        alice = auth_manager.account_id("alice")
        with accounts.as_account(alice):
            self.chat = session_manager.create_session(owner_user="alice")["id"]

        def forget_chat():
            with accounts.as_account(alice):
                session_manager.delete_session(self.chat)
        self.addCleanup(forget_chat)

    async def asyncTearDown(self):
        await self.http.aclose()

    async def ask(self, surface, tool="Bash", command="npm test", timeout=30):
        queue = permissions.open_channel(surface)
        task = asyncio.ensure_future(permissions.decide(surface=surface, tool=tool, arguments={"command": command}, timeout=timeout))
        request = await asyncio.wait_for(queue.get(), timeout=5)
        return task, request

    def answer(self, user, request, choice, **extra):
        return self.http.post(f"/api/permissions/{request['id']}/answer", json={"choice": choice, **extra}, headers=self.cookie[user])

    async def test_another_member_cannot_answer_someone_elses_prompt(self):
        task, request = await self.ask(f"chat:{self.chat}")
        denied = await self.answer("bob", request, "forever")
        self.assertEqual(denied.status_code, 404, denied.text)
        anonymous = await self.http.post(f"/api/permissions/{request['id']}/answer", json={"choice": "forever"})
        self.assertEqual(anonymous.status_code, 401)
        self.assertFalse(task.done(), "the request is still waiting for its owner")
        self.assertEqual(permissions.list_rules(), [], "nothing was granted by the refused answers")
        self.assertEqual((await self.answer("alice", request, "once")).status_code, 200)
        self.assertEqual((await task).behavior, "allow")
        self.assertEqual(permissions.list_rules(), [], "allow-once stores nothing")

    async def test_an_admin_cannot_answer_another_accounts_chat_prompt(self):
        # Multi-Account group 3: the chat is in Alice's account, which the admin cannot reach (decision D2).
        task, request = await self.ask(f"chat:{self.chat}")
        self.assertEqual((await self.answer("boss", request, "forever")).status_code, 404)
        self.assertEqual((await self.answer("alice", request, "forever")).status_code, 200)
        self.assertEqual((await task).behavior, "allow")
        rule = permissions.list_rules()[0]
        self.assertEqual((rule["granted_by"], rule["scope"], rule["content"]), ("alice", "forever", "npm test"))

    async def test_two_answers_at_once_settle_on_exactly_one(self):
        task, request = await self.ask(f"chat:{self.chat}")
        reject_id = next(c["id"] for c in request["choices"] if c["behavior"] == "deny")
        results = await asyncio.gather(self.answer("alice", request, "forever"), self.answer("alice", request, reject_id))
        codes = sorted(r.status_code for r in results)
        self.assertEqual(codes, [200, 409], "one answer wins, the other is told it is too late")
        decision = await task
        winner = "forever" if results[0].status_code == 200 else reject_id
        stored = permissions.list_rules()
        if winner == "forever":
            self.assertEqual(decision.behavior, "allow")
            self.assertEqual([r["scope"] for r in stored], ["forever"])
        else:
            self.assertEqual(decision.behavior, "deny")
            self.assertNotIn("allow", [r.get("behavior") for r in stored], "a lost allow must not leave a standing grant")
        audited = [e for e in permissions.audit() if e.get("request_id") == request["id"]]
        self.assertEqual(len(audited), 1, "exactly one decision is written down")

    async def test_an_unknown_choice_or_extra_scope_field_cannot_widen_a_grant(self):
        task, request = await self.ask(f"chat:{self.chat}")
        self.assertEqual((await self.answer("alice", request, "forever-everywhere")).status_code, 409)
        self.assertEqual((await self.answer("alice", request, "once", scope="forever")).status_code, 422)
        self.assertFalse(task.done())
        self.assertEqual(permissions.list_rules(), [])
        self.assertEqual((await self.answer("alice", request, "once")).status_code, 200)
        await task
        self.assertEqual(permissions.list_rules(), [])

    async def test_a_session_grant_is_exact_and_stays_in_its_chat(self):
        other = session_manager.create_session(owner_user="alice")["id"]
        self.addCleanup(session_manager.delete_session, other)
        task, request = await self.ask(f"chat:{self.chat}")
        session_id = next(c["id"] for c in request["choices"] if c["scope"] == "session")
        self.assertEqual((await self.answer("alice", request, session_id)).status_code, 200)
        await task
        self.assertIsNotNone(permissions.stored_decision(f"chat:{self.chat}", "Bash", "npm test"))
        self.assertIsNone(permissions.stored_decision(f"chat:{self.chat}", "Bash", "npm publish"), "a different command is asked again")
        self.assertIsNone(permissions.stored_decision(f"chat:{other}", "Bash", "npm test"), "another chat is asked again")
        self.assertIsNone(permissions.stored_decision(f"chat:{self.chat}", "Write", "npm test"), "another tool is asked again")
        permissions.drop_session(f"chat:{self.chat}")
        self.assertIsNone(permissions.stored_decision(f"chat:{self.chat}", "Bash", "npm test"), "ending the chat ends the grant")
        self.assertEqual([r for r in permissions.list_rules() if r["scope"] == "session"], [], "session grants are never written to disk")

    async def test_an_expired_request_cannot_be_answered_late(self):
        task, request = await self.ask(f"chat:{self.chat}", timeout=30)
        permissions._pending[request["id"]].expires_at = time.time() - 1
        late = await self.answer("alice", request, "forever")
        self.assertEqual(late.status_code, 409, late.text)
        self.assertFalse(task.done())
        self.assertEqual(permissions.list_rules(), [], "a late answer granted nothing")
        task.cancel()

    async def test_a_prompt_that_is_not_in_a_chat_is_an_admins_to_answer(self):
        task, request = await self.ask("task:nightly")
        self.assertEqual((await self.answer("alice", request, "forever")).status_code, 404)
        self.assertFalse(task.done())
        self.assertEqual((await self.answer("boss", request, "once")).status_code, 200)
        self.assertEqual((await task).behavior, "allow")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        from core import session_manager_store
        session_manager_store.close()
