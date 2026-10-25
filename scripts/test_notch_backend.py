"""The desktop notch's backend (Kairos Notch build spec, phase 2).

- A notch answer goes through the same routes as the app: a second answer
  gets 409, and an expired request answers nothing.
- Live turns carry their tool steps for every chat; the plain stream keeps
  its text-only bytes (scripts/test_forge_transcript.py).

Run: .venv\\Scripts\\python.exe scripts\\test_notch_backend.py
"""
import asyncio
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

from core import middleware, permissions, runs, session_manager_store as store
from core.auth import SINGLE_USER
from core.session_manager import session_manager
from routes import permission_routes
from services import chat_service


def tearDownModule():
    store.close()
    environment.cleanup()


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


if __name__ == "__main__":
    unittest.main()
