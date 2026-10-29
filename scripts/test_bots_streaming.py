"""Bot replies stream through the live feed; channels keep whole replies.

Phase 0 unit U5 (decision of 2026-10-28, reverses D9 for the app only).

Run: .venv/Scripts/python.exe scripts/test_bots_streaming.py
"""
import asyncio
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

fixture_path = Path(__file__).resolve().parents[1] / "data" / f"test-bots-streaming-{os.getpid()}"
fixture_path.mkdir(mode=0o777)
os.environ["JARVIS_DATA_DIR"] = str(fixture_path)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.channels import agent_routing
from services import chat_live, chat_service

CHUNKS = ["Found ", "three ", "changes ", "today."]


def new_run():
    return {"turnId": "turn-1", "sessionTitle": "Scout", "prompt": "What changed?", "text": "", "startedAt": 1.0,
            "status": "processing", "stopping": False, "permission": None, "toolEvents": [], "toolSteps": [],
            "handoffs": None, "runId": None, "error": None, "revision": 1, "provider": "",
            "waitingSince": 1.0, "providerDetail": None}


class BotStreaming(unittest.TestCase):
    def test_agent_session_chunks_are_broadcast_in_order_then_done(self):
        session_id = "bot-session"
        run = new_run()
        packets = []

        async def fake_stream(*args, **kwargs):
            for chunk in CHUNKS:
                yield chunk

        async def drive():
            queue, _ = chat_live.subscribe()
            try:
                with patch.object(chat_service, "stream_message", fake_stream), \
                     patch.object(chat_service, "release_session"), \
                     patch.object(chat_live, "_mobile_packet"), \
                     patch.object(chat_service.session_manager, "get_session",
                                  return_value={"id": session_id, "agent_id": "a1"}):
                    chat_live._runs[session_id] = run
                    await chat_live._run(session_id, run, [], True, "", [])
                while not queue.empty():
                    packets.append(queue.get_nowait())
            finally:
                chat_live.unsubscribe(queue)
                chat_live._runs.pop(session_id, None)

        asyncio.run(drive())
        chunks = [p for p in packets if p["type"] == "chunk"]
        self.assertEqual([p["chunk"] for p in chunks], CHUNKS)
        revisions = [p["revision"] for p in chunks]
        self.assertEqual(revisions, sorted(set(revisions)), "revisions strictly increase")
        self.assertTrue(all(p["sessionId"] == session_id and p["turnId"] == "turn-1" for p in chunks))
        last = packets[-1]
        self.assertEqual((last["type"], last["changes"]["status"]), ("update", "done"))
        self.assertLess(packets.index(chunks[-1]), packets.index(last), "done comes after the last chunk")
        self.assertEqual(run["text"], "".join(CHUNKS))

    def test_channel_direct_returns_whole_text_and_never_uses_live_feed(self):
        agent = {"id": "a1", "name": "Scout"}
        send = AsyncMock(return_value="Found three changes today.")
        with patch.object(agent_routing.agent_service, "chat_endpoint", return_value="ep1"), \
             patch.object(agent_routing.agent_service, "make_agent_chat"), \
             patch.object(agent_routing.session_manager, "get_or_create_channel_session", return_value="s-chan"), \
             patch.object(chat_service, "send_message", send), \
             patch.object(chat_live, "start") as start, \
             patch.object(chat_live, "_broadcast") as broadcast:
            reply = asyncio.run(agent_routing.direct(agent, "What changed?", "discord:1", "Discord"))
        self.assertEqual(reply, "Found three changes today.")
        send.assert_awaited_once()
        start.assert_not_called()
        broadcast.assert_not_called()

    def test_agent_routing_does_not_reference_the_live_feed(self):
        source = (Path(__file__).resolve().parents[1] / "core" / "channels" / "agent_routing.py").read_text(encoding="utf-8")
        self.assertNotIn("chat_live", source)


def cleanup():
    shutil.rmtree(fixture_path, ignore_errors=True)


if __name__ == "__main__":
    try:
        ok = unittest.main(exit=False, verbosity=2).result.wasSuccessful()
    finally:
        cleanup()
    sys.exit(0 if ok else 1)
