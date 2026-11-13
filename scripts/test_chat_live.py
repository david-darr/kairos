"""Live Chat/Forge turns survive viewer disconnects and reach other viewers.

Run: .venv/Scripts/python.exe scripts/test_chat_live.py
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
import shutil
import sys
import time
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


class SilentBrain(GatedBrain):
    """A model that has said nothing yet, as a local one does while it loads."""
    async def events(self, prompt):
        await self.continue_reply.wait()
        yield runs.text("Finally")
        yield runs.result(True)


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
        chat_live._ticker = None
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

    async def test_a_waiting_question_survives_text_that_follows_it(self):
        # Codex asks, writes "I'm waiting for your answer", and its process
        # ends while the question is still open (core/codex_questions.py).
        from core import permissions
        session_id = self.session_id

        class AskingBrain(GatedBrain):
            async def events(self, prompt):
                self.task = permissions.ask_later(surface=f"chat:{session_id}", agent_id=None, tool="ask_user",
                                                  raw_questions=[{"question": "Which one?", "options": [{"label": "A"}]}])
                await asyncio.sleep(0)
                yield runs.text("Waiting for your answer.")
                outcome = await self.task
                yield runs.text(f" Got {outcome.answers['Which one?']}.")
                yield runs.result(True)

        brain = AskingBrain()
        with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(brain, False))):
            chat_live.start(session_id, "Ask me", [], True, "", [])
            run = lambda: chat_live.snapshot()["runs"][session_id]
            await self.wait_for(lambda: run()["text"] == "Waiting for your answer." and run()["permission"])
            await asyncio.sleep(0.05)
            question = run()["permission"]
            self.assertEqual(question["kind"], "question")
            self.assertIsNone(permissions.respond(question["id"], answers={"Which one?": "A"}, skip=False, user="local"))
            await self.wait_for(lambda: run()["status"] == "done")
            self.assertIsNone(run()["permission"])
            self.assertEqual(run()["text"], "Waiting for your answer. Got A.")

    async def test_heartbeat_runs_only_while_a_run_is_active(self):
        beats = lambda viewer: sum(item["type"] == "heartbeat" for item in list(viewer._queue))
        viewer, _ = chat_live.subscribe()
        with patch.object(chat_live, "_HEARTBEAT_SECONDS", 0.02):
            await asyncio.sleep(0.1)
            self.assertEqual(beats(viewer), 0, "nothing is beating with no run")
            self.assertIsNone(chat_live._ticker)
            chat_live.start(self.session_id, "Build it", [], True, "", [])
            await self.wait_for(lambda: beats(viewer) >= 2)
            self.assertEqual(chat_live.visible_packet({"type": "heartbeat"}, "local"), {"type": "heartbeat"})
            self.assertTrue(all(len(json.dumps(item)) < 40 for item in list(viewer._queue) if item["type"] == "heartbeat"))
            self.brain.continue_reply.set()
            await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "done")
            await self.wait_for(lambda: chat_live._ticker is None)
            viewer._queue.clear()
            await asyncio.sleep(0.1)
            self.assertEqual(beats(viewer), 0, "a finished run stops the beat")
            self.brain.continue_reply.clear()
            chat_live.start(self.session_id, "Again", [], True, "", [])
            await self.wait_for(lambda: beats(viewer) >= 1)
            self.assertTrue(chat_live.stop(self.session_id))
            await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "stopped")
            await self.wait_for(lambda: chat_live._ticker is None)
            viewer._queue.clear()
            await asyncio.sleep(0.1)
            self.assertEqual(beats(viewer), 0, "a stopped run stops the beat")
        chat_live.unsubscribe(viewer)

    async def test_waiting_since_is_set_on_send_and_cleared_when_text_arrives(self):
        with patch.object(chat_live, "_ollama_target", return_value=None):
            brain = SilentBrain()
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(brain, False))):
                before = time.time()
                chat_live.start(self.session_id, "Hello", [], True, "", [])
                run = lambda: chat_live.snapshot()["runs"][self.session_id]
                self.assertTrue(before <= run()["waitingSince"] <= time.time())
                self.assertEqual(run()["provider"], "Test model")
                self.assertIsNone(run()["providerDetail"])
                self.assertFalse(any(key.startswith("_") for key in run()), "private fields stay server-side")
                await asyncio.sleep(0.05)
                self.assertIsNotNone(run()["waitingSince"], "no text yet: still waiting")
                brain.continue_reply.set()
                await self.wait_for(lambda: run()["text"] == "Finally")
                self.assertIsNone(run()["waitingSince"])
                await self.wait_for(lambda: run()["status"] == "done")

    async def test_the_wait_clock_pauses_for_a_tool_and_restarts_when_it_finishes(self):
        class ToolBrain(GatedBrain):
            """Calls a tool, then thinks silently, as a local model does after its helpers report."""
            def __init__(self):
                super().__init__()
                self.tool_done = asyncio.Event()
            async def events(self, prompt):
                yield runs.tool_started("c1", "delegate", {"jobs": []})
                await self.tool_done.wait()
                yield runs.tool_finished("c1", True, "Helpers' results")
                await self.continue_reply.wait()
                yield runs.text("Both done")
                yield runs.result(True)

        brain = ToolBrain()
        with patch.object(chat_live, "_ollama_target", return_value=None), \
                patch.object(chat_service, "_get_brain", AsyncMock(return_value=(brain, False))):
            chat_live.start(self.session_id, "Delegate", [], True, "", [])
            run = lambda: chat_live.snapshot()["runs"][self.session_id]
            await self.wait_for(lambda: len(run()["toolSteps"]) == 1)
            self.assertIsNone(run()["waitingSince"], "a running tool is not a slow model")
            before = time.time()
            brain.tool_done.set()
            await self.wait_for(lambda: len(run()["toolSteps"]) == 2)
            self.assertAlmostEqual(run()["waitingSince"], run()["toolSteps"][1]["at"], delta=0.01)
            self.assertGreaterEqual(run()["waitingSince"], before - 0.01, "the clock restarts from the tool's finish")
            brain.continue_reply.set()
            await self.wait_for(lambda: run()["text"] == "Both done")
            self.assertIsNone(run()["waitingSince"])
            await self.wait_for(lambda: run()["status"] == "done")

    async def test_a_run_that_ends_without_text_clears_the_wait(self):
        viewer, _ = chat_live.subscribe()
        with patch.object(chat_live, "_ollama_target", return_value=None):
            brain = SilentBrain()
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(brain, False))):
                chat_live.start(self.session_id, "Hello", [], True, "", [])
                self.assertTrue(chat_live.stop(self.session_id))
                await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "stopped")
        self.assertIsNone(chat_live.snapshot()["runs"][self.session_id]["waitingSince"])
        self.assertIn(None, [item["changes"].get("waitingSince", 0) for item in list(viewer._queue) if item["type"] == "update"])
        chat_live.unsubscribe(viewer)

    async def test_ollama_detail_says_loading_or_working_and_is_rate_limited(self):
        target = ("http://127.0.0.1:11434", "qwen3")
        with patch.object(chat_live, "_ollama_target", return_value=target):
            brain = SilentBrain()
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(brain, False))):
                chat_live.start(self.session_id, "Hello", [], True, "", [])
                run = chat_live._runs[self.session_id]
                since = run["waitingSince"]
                viewer, _ = chat_live.subscribe()
                ps = AsyncMock(return_value=[])
                with patch("core.ollama_client.list_running", ps):
                    await chat_live._check_waits(since + 59)
                    self.assertEqual(ps.await_count, 0, "no check before a minute")
                    await chat_live._check_waits(since + 61)
                    self.assertEqual(ps.await_count, 1)
                    ps.assert_awaited_with("http://127.0.0.1:11434")
                    self.assertEqual(chat_live.snapshot()["runs"][self.session_id]["providerDetail"], "Loading the model into memory")
                    await chat_live._check_waits(since + 65)
                    self.assertEqual(ps.await_count, 1, "at most one check every 10 s")
                    ps.return_value = [{"name": "qwen3:latest", "model": "qwen3:latest"}]
                    await chat_live._check_waits(since + 72)
                    self.assertEqual(ps.await_count, 2)
                    self.assertEqual(chat_live.snapshot()["runs"][self.session_id]["providerDetail"], "Model is working")
                    updates = [item["changes"] for item in list(viewer._queue) if item["type"] == "update"]
                    self.assertEqual([c["providerDetail"] for c in updates if "providerDetail" in c],
                                     ["Loading the model into memory", "Model is working"])
                    await chat_live._check_waits(since + 73)
                    self.assertEqual(ps.await_count, 2)
                    ps.side_effect = httpx.ConnectError("down")
                    await chat_live._check_waits(since + 90)
                    self.assertEqual(ps.await_count, 3)
                    self.assertIsNone(chat_live.snapshot()["runs"][self.session_id]["providerDetail"], "a failed check shows nothing")
                brain.continue_reply.set()
                await self.wait_for(lambda: chat_live.snapshot()["runs"][self.session_id]["status"] == "done")
                with patch("core.ollama_client.list_running", ps):
                    ps.reset_mock()
                    await chat_live._check_waits(since + 200)
                    self.assertEqual(ps.await_count, 0, "a finished run is never checked")
                chat_live.unsubscribe(viewer)

    async def test_only_a_loopback_ollama_gets_the_check(self):
        def target(base_url, kind="local"):
            with patch.object(chat_service, "_resolve_endpoint", return_value={**ENDPOINT, "kind": kind}), \
                 patch("core.model_endpoints.resolve_runtime", return_value=(base_url, "m", None, 4096)):
                return chat_live._ollama_target(self.session_id)
        self.assertEqual(target("http://localhost:11434/v1"), ("http://localhost:11434", "m"))
        self.assertIsNone(target("http://192.168.1.5:11434"))
        self.assertIsNone(target("http://localhost:8000/v1"), "not Ollama")
        self.assertIsNone(target("http://localhost:11434", kind="api"))


class PhonePushNameTests(unittest.TestCase):
    """A phone push's title for a model chat is the model's name as the picker shows it, never a provider id."""

    def name(self, endpoint, session=None):
        with patch.object(chat_service, "_resolve_endpoint", return_value=endpoint),                 patch.object(chat_service.session_manager, "get_session", return_value=session or {}):
            return chat_live._model_display_name("s1")

    def test_the_catalog_name_then_the_model_id_then_kairos(self):
        claude = {"kind": "claude_cli", "name": "anthropic", "model": "claude-opus-5-5"}
        self.assertEqual(self.name(claude), "Opus 5.5")
        self.assertEqual(self.name(claude, {"model_override": "sonnet"}), "Sonnet 5.5", "the chat's own pick wins")
        self.assertEqual(self.name({"kind": "api", "name": "openai", "model": "gpt-test"}), "gpt-test")
        self.assertEqual(self.name({"kind": "claude_cli", "name": "anthropic", "model": ""}), "Kairos")
        self.assertEqual(self.name(None), "Kairos")


if __name__ == "__main__":
    try:
        result = unittest.main(exit=False).result
    finally:
        session_manager_store.close()
        if fixture_path.resolve().parent != (Path(__file__).resolve().parents[1] / "data").resolve():
            raise RuntimeError("test fixture escaped the repository data directory")
        shutil.rmtree(fixture_path)
    sys.exit(0 if result.wasSuccessful() else 1)
