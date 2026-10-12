"""Live Chat/Forge turns survive viewer disconnects and reach other viewers.

Run: .venv/Scripts/python.exe scripts/test_chat_live.py
"""
import asyncio
from contextlib import asynccontextmanager
import os
import shutil
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

fixture_path = Path(__file__).resolve().parents[1] / "data" / f"test-chat-live-{os.getpid()}"
fixture_path.mkdir(mode=0o777)
os.environ["JARVIS_DATA_DIR"] = str(fixture_path)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from core import runs
from core.session_manager import session_manager
from core import session_manager_store
from routes import chat_routes
from services import chat_live, chat_service

app = FastAPI()
app.include_router(chat_routes.router)
ENDPOINT = {"id": "local-test", "name": "Test model", "kind": "local", "model": "test"}


@asynccontextmanager
async def no_checkpoint(*args, **kwargs):
    yield


class GatedBrain:
    def __init__(self):
        self.continue_reply = asyncio.Event()
        self.cancelled = False

    async def events(self, prompt):
        yield runs.text("First half")
        await self.continue_reply.wait()
        yield runs.text(" and second half")
        yield runs.result(True)

    async def cancel(self):
        self.cancelled = True
        return SimpleNamespace(confirmed=True, how="test")


class LiveChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session_id = session_manager.create_session()["id"]
        workspace = fixture_path / self.session_id
        workspace.mkdir()
        session_manager.set_workspace(self.session_id, str(workspace))
        self.brain = GatedBrain()
        self.endpoint_patch = patch.object(chat_service, "_resolve_endpoint", return_value=ENDPOINT)
        self.brain_patch = patch.object(chat_service, "_get_brain", AsyncMock(return_value=(self.brain, False)))
        self.close_patch = patch.object(chat_service, "close_session_brain", AsyncMock())
        self.checkpoint_patch = patch.object(chat_service.file_checkpoints, "around_turn", no_checkpoint)
        self.endpoint_patch.start()
        self.brain_patch.start()
        self.close_patch.start()
        self.checkpoint_patch.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await chat_live.shutdown()
        await self.client.aclose()
        self.endpoint_patch.stop()
        self.brain_patch.stop()
        self.close_patch.stop()
        self.checkpoint_patch.stop()
        chat_live._runs.clear()
        chat_live._subscribers.clear()
        chat_service._busy.clear()

    async def wait_for(self, condition):
        for _ in range(100):
            if condition():
                return
            await asyncio.sleep(0.01)
        self.fail(f"live turn did not reach the expected state: {chat_live.snapshot()}")

    async def test_two_viewers_and_departure_do_not_stop_reply(self):
        first, initial = chat_live.subscribe()
        second, _ = chat_live.subscribe()
        self.assertEqual(initial["runs"], {})
        result = await self.client.post("/api/chat/live", json={"session_id": self.session_id, "message": "Build it"})
        self.assertEqual(result.status_code, 200, result.text)
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["text"] == "First half")
        self.assertTrue(chat_service.is_busy(self.session_id))
        self.assertEqual(chat_live.snapshot()["runs"][self.session_id]["prompt"], "Build it")
        self.assertTrue(any(item["type"] == "chunk" for item in list(second._queue)))
        chat_live.unsubscribe(first)  # The sending browser closes.
        self.brain.continue_reply.set()
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "done")
        await self.wait_for(lambda: not chat_service.is_busy(self.session_id))
        self.assertEqual(chat_live.snapshot()["runs"][self.session_id]["text"], "First half and second half")
        self.assertTrue(any(item.get("changes", {}).get("status") == "done" for item in list(second._queue)))
        self.assertEqual(session_manager.get_session(self.session_id)["messages"][-1]["content"],
                         "First half and second half")
        chat_live.unsubscribe(second)

    async def test_closing_event_feed_only_unsubscribes_viewer(self):
        response = await chat_routes.live_chat_events(user="local")
        stream = response.body_iterator
        self.assertIn('"type": "snapshot"', await anext(stream))
        self.assertEqual(len(chat_live._subscribers), 1)
        chat_live.start(self.session_id, "Keep working", [], True, "", [])
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["text"] == "First half")
        await stream.aclose()
        self.assertEqual(len(chat_live._subscribers), 0)
        self.brain.continue_reply.set()
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "done")

    async def test_stop_is_explicit_and_preserves_partial_reply(self):
        result = await self.client.post("/api/chat/live", json={"session_id": self.session_id, "message": "Wait"})
        self.assertEqual(result.status_code, 200, result.text)
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["text"] == "First half")
        stopped = await self.client.post("/api/chat/live/stop", json={"session_id": self.session_id})
        self.assertEqual(stopped.json(), {"stopping": True})
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "stopped")
        await self.wait_for(lambda: not chat_service.is_busy(self.session_id))
        self.assertEqual(session_manager.get_session(self.session_id)["messages"][-1]["status"], "interrupted")
        self.assertEqual(session_manager.get_session(self.session_id)["messages"][-1]["content"], "First half")
        self.assertTrue(self.brain.cancelled)

    async def test_immediate_stop_releases_session_reservation(self):
        chat_live.start(self.session_id, "Stop before start", [], True, "", [])
        self.assertTrue(chat_service.is_busy(self.session_id))
        self.assertTrue(chat_live.stop(self.session_id))
        await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "stopped")
        self.assertFalse(chat_service.is_busy(self.session_id))

    async def test_permission_is_in_snapshot_and_clears_for_all_viewers(self):
        gate = asyncio.Event()
        request = {"id": "ask-test", "tool": "run_shell", "title": "Run command", "choices": []}

        async def asking(*args, **kwargs):
            yield {"permission": request}
            await gate.wait()

        with patch.object(chat_service, "stream_message", asking):
            chat_live.start(self.session_id, "Need approval", [], True, "", [])
            await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["permission"] == request)
            viewer, initial = chat_live.subscribe()
            self.assertEqual(initial["runs"][self.session_id]["permission"], request)
            chat_live.permission_answered(request["id"])
            self.assertIsNone(chat_live.snapshot()["runs"][self.session_id]["permission"])
            self.assertTrue(any(item.get("changes", {}).get("permission", "missing") is None
                                for item in list(viewer._queue)))
            gate.set()
            await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "done")
            chat_live.unsubscribe(viewer)


if __name__ == "__main__":
    try:
        result = unittest.main(exit=False).result
    finally:
        session_manager_store.close()
        if fixture_path.resolve().parent != (Path(__file__).resolve().parents[1] / "data").resolve():
            raise RuntimeError("test fixture escaped the repository data directory")
        shutil.rmtree(fixture_path)
    sys.exit(0 if result.wasSuccessful() else 1)
