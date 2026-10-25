"""The desktop notch's backend (Kairos Notch build spec, phases 2 and 3).

- A folder dropped on the notch asks the broker for a path-root grant:
  once (this chat only, gone when the chat ends), always (a saved rule for
  exactly that folder), reject (nothing attached). Auto never answers it.
- The chat gets the path and a capped listing as a reference, and only while
  the broker still allows it; the turn that reads it is tainted.
- A notch answer goes through the same routes as the app: a second answer
  gets 409, and an expired request answers nothing.
- Live turns carry their tool steps for every chat; the plain stream keeps
  its text-only bytes (scripts/test_forge_transcript.py).
- The notch's routes are cookie-only: a paired terminal cannot use them.

Run: .venv\\Scripts\\python.exe scripts\\test_notch_backend.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
environment = tempfile.TemporaryDirectory(prefix="kairos-notch-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx
from fastapi import FastAPI

from core import chat_references, cli_access, middleware, notch_folders, permissions, runs, session_manager_store as store
from core.auth import SINGLE_USER
from core.session_manager import session_manager
from routes import notch_routes, permission_routes
from services import chat_service


def tearDownModule():
    store.close()
    environment.cleanup()


def events(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


class NotchFolderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.files = tempfile.TemporaryDirectory(dir=environment.name)
        self.folder = os.path.join(self.files.name, "project")
        os.makedirs(os.path.join(self.folder, "src"))
        for name in ("README.md", "src/app.js"):
            Path(self.folder, name).write_text("secret body text", encoding="utf-8")
        self.rules = patch.object(permissions, "PERMISSIONS_FILE", os.path.join(self.files.name, "permissions.json"))
        self.rules.start()
        permissions._session_rules.clear(); permissions._channels.clear(); permissions._pending.clear()
        notch_folders._grants.clear()
        self.session = session_manager.create_session("Notch fixture", owner_user=SINGLE_USER)
        self.id = self.session["id"]
        self.app = FastAPI()
        self.app.include_router(notch_routes.router)
        self.app.include_router(permission_routes.router)
        for dependency in (middleware.require_admin, middleware.require_user):
            self.app.dependency_overrides[dependency] = lambda: SINGLE_USER

    async def asyncTearDown(self):
        self.rules.stop()
        store.delete_all_sessions()
        self.files.cleanup()

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://notch")

    async def drop(self, choice, path=None):
        """Drop a folder and answer its request through the permission route,
        as the notch does. Returns the stream's events and the request."""
        async with self.client() as client:
            stream = asyncio.create_task(client.post("/api/notch/folder", json={"session_id": self.id, "path": path or self.folder}))
            request = None
            for _ in range(200):
                pending = [r for r in permissions._pending.values() if r.surface == f"chat:{self.id}"]
                if pending:
                    request = pending[0]
                    break
                if stream.done():
                    break
                await asyncio.sleep(0.01)
            if request is not None and choice:
                answered = await client.post(f"/api/permissions/{request.id}/answer", json={"choice": choice})
                self.assertEqual(answered.status_code, 200)
            response = await asyncio.wait_for(stream, 5)
            self.assertEqual(response.status_code, 200, response.text)
            return events(response.text), request

    def resolve(self, folder):
        return chat_references.resolve(self.id, [{"kind": "folder", "id": folder["id"], "session_id": self.id, "label": folder["label"]}],
                                       True, SINGLE_USER)

    async def test_the_request_states_the_path_and_each_scope_in_words(self):
        packets, request = await self.drop("reject")
        asked = packets[0]["permission"]
        self.assertEqual(asked["tool"], notch_folders.TOOL)
        self.assertEqual(asked["target"], self.folder)
        self.assertIn(self.folder, asked["title"])
        self.assertEqual([c["id"] for c in asked["choices"]], ["once", "forever", "reject"])
        self.assertEqual(asked["choices"][1]["label"], f"Always allow reading {self.folder}")

    async def test_reject_attaches_nothing(self):
        packets, _ = await self.drop("reject")
        self.assertEqual(packets[-1], {"status": "rejected"})
        self.assertEqual(notch_folders._grants, {})
        self.assertIsNone(session_manager.get_session(self.id).get("untrusted_context"))

    async def test_once_lasts_for_this_chat_only_and_ends_with_it(self):
        packets, _ = await self.drop("once")
        self.assertEqual(packets[-1]["status"], "allowed")
        folder = packets[-1]["folder"]
        context = self.resolve(folder)
        self.assertIn(f"Folder: {self.folder}", context)
        self.assertIn("README.md", context)
        self.assertIn("src" + os.sep, context)
        self.assertNotIn("secret body text", context, "names only, never contents")
        self.assertIn("UNTRUSTED", context.upper(), "the listing is fenced as untrusted reference text")
        self.assertEqual(session_manager.get_session(self.id)["untrusted_context"], "a folder dropped on the desktop notch")
        self.assertEqual(permissions._load()["rules"], [], "once saves no rule")
        # Another chat is asked again: once belongs to this chat.
        self.assertIsNone(notch_folders.saved_decision("other-chat", self.folder))
        # Deleting the chat ends it.
        notch_folders.forget_session(self.id)
        self.assertIsNone(notch_folders.saved_decision(self.id, self.folder))
        with self.assertRaises(ValueError):
            self.resolve(folder)

    async def test_always_saves_a_rule_for_exactly_that_folder(self):
        packets, _ = await self.drop("forever")
        self.assertEqual(packets[-1]["status"], "allowed")
        rules = [r for r in permissions._load()["rules"] if r["tool"] == notch_folders.TOOL]
        self.assertEqual([(r["content"], r["scope"]) for r in rules], [(self.folder, "forever")])
        again, request = await self.drop(None)
        self.assertIsNone(request, "an always grant is not asked again")
        self.assertEqual(again[-1]["status"], "allowed")
        sibling = self.folder + "2"
        os.makedirs(sibling)
        self.assertIsNone(notch_folders.saved_decision(self.id, sibling), "no prefix match onto a sibling folder")
        # Revoking it in Settings stops the folder at the next send.
        permissions.revoke(rules[0]["id"])
        with self.assertRaises(ValueError):
            self.resolve(again[-1]["folder"])

    async def test_auto_mode_never_answers_a_folder(self):
        session_manager.set_permission_mode(self.id, "auto")
        packets, request = await self.drop("reject")
        self.assertIsNotNone(request, "the person is asked even in an Auto chat")
        self.assertEqual(packets[-1], {"status": "rejected"})

    async def test_a_closed_notch_denies(self):
        async with self.client() as client:
            stream = asyncio.create_task(client.post("/api/notch/folder", json={"session_id": self.id, "path": self.folder}))
            for _ in range(200):
                if permissions._pending:
                    break
                await asyncio.sleep(0.01)
            permissions.close_channel(f"chat:{self.id}")
            response = await asyncio.wait_for(stream, 5)
        self.assertEqual(events(response.text)[-1], {"status": "rejected"})

    async def test_only_real_folders_and_a_free_chat(self):
        async with self.client() as client:
            for path in ("relative/path", os.path.join(self.folder, "README.md"), self.folder + "\x00x"):
                response = await client.post("/api/notch/folder", json={"session_id": self.id, "path": path})
                self.assertEqual(response.status_code, 422, path)
            permissions.open_channel(f"chat:{self.id}")
            busy = await client.post("/api/notch/folder", json={"session_id": self.id, "path": self.folder})
            self.assertEqual(busy.status_code, 409)

    async def test_a_grant_is_this_persons_and_this_chats(self):
        packets, _ = await self.drop("once")
        folder = packets[-1]["folder"]
        with self.assertRaises(ValueError):
            chat_references.resolve(self.id, [{"kind": "folder", "id": folder["id"]}], True, "mallory")
        with self.assertRaises(ValueError):
            chat_references.resolve("another-chat", [{"kind": "folder", "id": folder["id"]}], True, SINGLE_USER)
        with self.assertRaises(ValueError):
            chat_references.resolve(self.id, [{"kind": "folder", "id": "invented"}], True, SINGLE_USER)

    async def test_the_listing_is_capped(self):
        many = os.path.join(self.files.name, "many")
        os.makedirs(many)
        for index in range(notch_folders.LISTING_LIMIT + 20):
            Path(many, f"f{index:03}.txt").write_text("x", encoding="utf-8")
        names, cut = notch_folders.listing(many)
        self.assertEqual(len(names), notch_folders.LISTING_LIMIT)
        self.assertTrue(cut)

    async def test_dropped_files_mark_the_chat_untrusted(self):
        async with self.client() as client:
            response = await client.post("/api/notch/dropped", json={"session_id": self.id})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(session_manager.get_session(self.id)["untrusted_context"], "files dropped on the desktop notch")


class NotchAnswerTests(unittest.IsolatedAsyncioTestCase):
    """The notch answers with the app's routes, and the server holds the line."""
    async def asyncSetUp(self):
        self.files = tempfile.TemporaryDirectory(dir=environment.name)
        self.rules = patch.object(permissions, "PERMISSIONS_FILE", os.path.join(self.files.name, "permissions.json"))
        self.rules.start()
        permissions._session_rules.clear(); permissions._channels.clear(); permissions._pending.clear()
        self.session = session_manager.create_session("Answer fixture", owner_user=SINGLE_USER)
        self.surface = f"chat:{self.session['id']}"
        self.app = FastAPI()
        self.app.include_router(permission_routes.router)
        self.app.dependency_overrides[middleware.require_user] = lambda: SINGLE_USER

    async def asyncTearDown(self):
        self.rules.stop()
        store.delete_all_sessions()
        self.files.cleanup()

    async def ask(self, timeout=5):
        queue = permissions.open_channel(self.surface)
        decision = asyncio.create_task(permissions.decide(surface=self.surface, tool="Bash",
                                                          arguments={"command": "ls -la"}, timeout=timeout))
        return decision, await asyncio.wait_for(queue.get(), 5)

    async def test_a_second_answer_gets_409(self):
        decision, request = await self.ask()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://notch") as client:
            first = await client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})
            second = await client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "reject"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 409)
        self.assertEqual((await decision).behavior, "allow", "the first answer stands")

    async def test_an_expired_request_answers_nothing(self):
        decision, request = await self.ask(timeout=0.2)
        self.assertLessEqual(request["expires_at"], time.time() + 1)
        await asyncio.sleep(0.3)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://notch") as client:
            late = await client.post(f"/api/permissions/{request['id']}/answer", json={"choice": "once"})
        self.assertEqual(late.status_code, 409)
        self.assertEqual((await decision).behavior, "deny")


class LiveStepTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_turns_carry_tool_steps_for_every_chat(self):
        session = session_manager.create_session("Steps fixture", owner_user=SINGLE_USER)
        context = runs.RunContext("chat", session_id=session["id"])
        sequence = [runs.text("Before"), runs.tool_started("read", "Read", {"file_path": "notes/q4.md"}),
                    runs.tool_finished("read", True, "3 lines"), runs.text("After"), runs.result(True)]

        class Brain:
            async def events(self, prompt):
                for event in sequence:
                    yield event

        async def collect(live):
            async def body():
                if live:
                    chat_service.LIVE_STEPS.set(True)
                runs.enter(context)
                try:
                    return [item async for item in chat_service._stream_with_permission_prompts(session["id"], Brain(), "x", runs.Tally())]
                finally:
                    runs.leave(context)
                    runs.CURRENT.set(None)
            return await asyncio.create_task(body())

        plain = await collect(False)
        self.assertEqual(plain, ["Before", "After"], "the plain stream is unchanged")
        live = await collect(True)
        steps = [item["tool_step"] for item in live if isinstance(item, dict)]
        self.assertEqual([(s["phase"], s["name"], s["summary"]) for s in steps],
                         [("started", "Read", "notes/q4.md"), ("finished", "Read", "notes/q4.md")])
        self.assertFalse(chat_service.LIVE_STEPS.get(), "the flag stays inside the live task")
        store.delete_all_sessions()


class CookieOnlyTests(unittest.TestCase):
    def test_a_terminal_token_cannot_reach_the_notch_routes(self):
        for path in ("/api/notch/folder", "/api/notch/dropped"):
            self.assertFalse(cli_access.token_route_allowed(path), path)
        self.assertTrue(cli_access.token_route_allowed("/api/chat/live"))


if __name__ == "__main__":
    unittest.main()
