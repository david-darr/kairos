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

    def test_stop_names_its_turn_and_a_stale_turn_id_is_a_no_op(self):
        async def drive():
            run = new_run()
            sid = "guard-session"
            task = asyncio.create_task(asyncio.sleep(30))
            chat_live._runs[sid], chat_live._tasks[sid] = run, task
            try:
                self.assertFalse(chat_live.stop(sid, "an-older-turn"))
                self.assertEqual(chat_live.stop_turn(sid, "an-older-turn"), "already-stopped")
                self.assertFalse(task.cancelled() or run["stopping"])
                self.assertEqual(chat_live.stop_turn(sid, "turn-1"), "stopping")
                self.assertTrue(run["stopping"] and run["_stop_reason"] == "person")
                self.assertTrue(chat_live.stop(sid), "the old call without a turn still works")
            finally:
                task.cancel()
                chat_live._runs.pop(sid, None)
                chat_live._tasks.pop(sid, None)
        with patch.object(chat_live, "_mobile_packet"):
            asyncio.run(drive())

    def test_a_turn_with_an_accepted_message_does_not_append_it_again(self):
        from core.session_manager import session_manager
        session = session_manager.create_session("Accepted", owner_user="david")
        self.addCleanup(session_manager.delete_session, session["id"])
        index = session_manager.append_message(session["id"], "user", "already saved")
        endpoint = {"id": "e", "name": "E", "kind": "claude_cli"}

        class Brain:
            async def events(self, prompt, stream=True):
                from core import runs
                yield runs.text("reply")
                yield runs.result(True)

        async def drive():
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(Brain(), False))),                  patch.object(chat_service, "_resolve_endpoint", return_value=endpoint),                  patch.object(chat_service, "_compact_if_nearly_full", AsyncMock()),                  patch.object(chat_service, "_reply_hook"), patch.object(chat_service, "_record_turn_telemetry"):
                async with chat_service.session_operation(session["id"]):
                    return [c async for c in chat_service._stream_message(
                        session["id"], "already saved", None, True, "", None, accepted_index=index, turn_note="[note]")]

        self.assertEqual([c for c in asyncio.run(drive()) if isinstance(c, str)], ["reply"])
        rows = session_manager.get_session(session["id"])["messages"]
        self.assertEqual([m["role"] for m in rows], ["user", "assistant"])
        self.assertEqual(rows[0]["sent"], "already saved[note]", "the private note went to the model, not the transcript")

    def test_the_chunk_filter_keeps_text_out_of_the_live_feed(self):
        from services import bot_goal_runs
        packets = []
        run = new_run()
        run["_filter"] = bot_goal_runs.EnvelopeFilter()

        async def fake_stream(*args, **kwargs):
            for chunk in ["Hello <kairos", "-goal>{}</kairos-goal>", " there"]:
                yield chunk

        async def drive():
            queue, _ = chat_live.subscribe()
            try:
                with patch.object(chat_service, "stream_message", fake_stream), patch.object(chat_service, "release_session"),                      patch.object(chat_live, "_mobile_packet"),                      patch.object(chat_service.session_manager, "get_session", return_value={"id": "f", "agent_id": "a1"}):
                    chat_live._runs["f"] = run
                    await chat_live._run("f", run, [], True, "", [])
                while not queue.empty():
                    packets.append(queue.get_nowait())
            finally:
                chat_live.unsubscribe(queue)
                chat_live._runs.pop("f", None)

        asyncio.run(drive())
        self.assertEqual("".join(p["chunk"] for p in packets if p["type"] == "chunk"), "Hello  there")
        self.assertEqual(run["text"], "Hello  there")

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


# David, 2026-11-11: Kip's reply ended with a raw {"status": "needs-input", ...} line.
LEAK = ('Do you want me to ring you now anyway?\n{"status": "needs-input", "instruction": "Wait for the user to say '
        'whether to ring now.", "detail": "Asked whether to ring anyway."}')
SHOWN = "Do you want me to ring you now anyway?"


class GoalBlockNeverShows(unittest.TestCase):
    """A goal block (tagged, or bare JSON of exactly its shape at the end) is never shown or saved outside a goal turn:
    the Bots chat and classic chat stream (chat_service.stream_message) and Discord, Telegram and other channel replies
    (chat_service.send_message). JSON the person asked for stays."""

    def stream(self, chunks, turn_note=""):
        from core import runs
        from core.session_manager import session_manager
        session = session_manager.create_session("Goal block", owner_user="david")
        self.addCleanup(session_manager.delete_session, session["id"])
        index = session_manager.append_message(session["id"], "user", "call me on discord")
        endpoint = {"id": "e", "name": "E", "kind": "claude_cli"}

        class Brain:
            async def events(self, prompt, stream=True):
                for chunk in chunks:
                    yield runs.text(chunk)
                yield runs.result(True)

        async def drive():
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(Brain(), False))), \
                 patch.object(chat_service, "_resolve_endpoint", return_value=endpoint), \
                 patch.object(chat_service, "_compact_if_nearly_full", AsyncMock()), \
                 patch.object(chat_service, "_reply_hook"), patch.object(chat_service, "_record_turn_telemetry"):
                async with chat_service.session_operation(session["id"]):
                    return [c async for c in chat_service._stream_message(
                        session["id"], "call me on discord", None, True, "", None, accepted_index=index, turn_note=turn_note)]

        shown = "".join(c for c in asyncio.run(drive()) if isinstance(c, str))
        return shown, session_manager.get_session(session["id"])["messages"][-1]["content"]

    def split(self, text, size):
        return [text[i:i + size] for i in range(0, len(text), size)]

    def test_a_bare_goal_block_at_the_end_is_never_streamed_or_saved(self):
        for size in (1, 4, 17, len(LEAK)):
            shown, saved = self.stream(self.split(LEAK, size))
            self.assertEqual(shown.rstrip(), SHOWN, size)
            self.assertEqual(saved, SHOWN, size)

    def test_a_tagged_block_in_an_ordinary_turn_is_never_shown(self):
        tagged = 'Done.\n<kairos-goal>{"status": "completed", "instruction": "", "detail": "d"}</kairos-goal>'
        shown, saved = self.stream(self.split(tagged, 5))
        self.assertEqual((shown.rstrip(), saved), ("Done.", "Done."))

    def test_json_the_person_asked_for_is_kept(self):
        for reply in ('Here it is:\n{"name": "Kip", "status": "needs-input"}',
                      'Here:\n```json\n{"status": "blocked", "detail": "d"}\n```',
                      '{"status": "needs-input", "instruction": "x", "detail": "y"}',
                      'Mid {"status": "blocked", "detail": "d"} and more text after it.'):
            shown, saved = self.stream(self.split(reply, 3))
            self.assertEqual((shown, saved), (reply, reply))

    def test_a_goal_turn_keeps_its_control_line_for_the_goal_runner(self):
        from services import bot_goal_runs
        shown, saved = self.stream([LEAK], turn_note=bot_goal_runs.NOTE)
        self.assertEqual(saved, LEAK, "the runner reads it from the saved reply, then removes it")
        self.assertEqual(bot_goal_runs.parse(saved)[1]["status"], "needs-input")

    def test_discord_and_telegram_replies_never_carry_it(self):
        from core.session_manager import session_manager
        session = session_manager.create_session("Channel", owner_user="david")
        self.addCleanup(session_manager.delete_session, session["id"])
        endpoint = {"id": "e", "name": "E", "kind": "claude_cli"}

        class Brain:
            pass

        async def drive(reply):
            with patch.object(chat_service, "_get_brain", AsyncMock(return_value=(Brain(), False))), \
                 patch.object(chat_service, "_resolve_endpoint", return_value=endpoint), \
                 patch.object(chat_service, "_compact_if_nearly_full", AsyncMock()), \
                 patch.object(chat_service.runs, "complete", AsyncMock(return_value=MagicMock(text=reply, usage=None))), \
                 patch.object(chat_service, "_reply_hook"), patch.object(chat_service, "_record_turn_telemetry"), \
                 patch.object(chat_service, "_prime_with_history", side_effect=lambda sid, created, ep, text, brain: text):
                return await chat_service.send_message(session["id"], "call me on discord")

        self.assertEqual(asyncio.run(drive(LEAK)), SHOWN)
        self.assertEqual(session_manager.get_session(session["id"])["messages"][-1]["content"], SHOWN)
        asked = 'Sure:\n{"name": "Kip"}'
        self.assertEqual(asyncio.run(drive(asked)), asked)


def cleanup():
    shutil.rmtree(fixture_path, ignore_errors=True)


if __name__ == "__main__":
    try:
        ok = unittest.main(exit=False, verbosity=2).result.wasSuccessful()
    finally:
        cleanup()
    sys.exit(0 if ok else 1)
