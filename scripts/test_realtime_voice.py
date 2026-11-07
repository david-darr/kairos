"""Realtime speech-to-speech (build spec 6b, Track A) against MOCK providers only: a loopback WebSocket server stands in for
OpenAI, xAI and Google, so nothing here touches the network, a key or an account of anyone's.

What this proves is that OUR side is consistent: session setup per provider, audio framing and resampling, the do_work
round trip, interruption truncation, that the key never reaches the browser, per-account keys, minute counting and the
phone bridge in realtime mode. It cannot prove a real provider accepts the messages (see core/realtime_voice.py).
Run: python scripts/test_realtime_voice.py
"""
import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="kairos-realtime-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import accounts, model_endpoints, phone_audio, realtime_settings, realtime_usage, realtime_voice  # noqa: E402
from core.middleware import require_user  # noqa: E402
from core.phone_providers import Twilio  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core import session_manager_store as store  # noqa: E402
from realtime_mock import MockRealtime, b64, gemini_audio, openai_audio, openai_text, openai_tool  # noqa: E402
from routes import call_routes  # noqa: E402
from services import agent_calls as calls, realtime_phone, realtime_session  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

# connections live in account folders only once the layout is migrated; a fresh test data folder is at the latest layout
from core import account_migration  # noqa: E402
os.makedirs(DATA.name, exist_ok=True)
with open(os.path.join(DATA.name, "layout.json"), "w", encoding="utf-8") as _layout:
    json.dump({"version": account_migration.STEPS[-1].version}, _layout)
account_migration._moved.clear()

KEYS = {"openai": "sk-test-OPENAI-secret-111", "xai": "xai-test-GROK-secret-222", "gemini": "AIza-test-GEMINI-secret-333"}
URLS = {"openai": "https://api.openai.com/v1", "xai": "https://api.x.ai/v1",
        "gemini": "https://generativelanguage.googleapis.com/v1beta/openai"}


def tone16(ms, rate=16000, freq=300, amp=0.3):
    count = rate * ms // 1000
    return phone_audio.float_to_pcm16(amp * np.sin(2 * np.pi * freq * np.arange(count) / rate))


class FakeConversation:
    def __init__(self, *args):
        pass

    async def close(self):
        pass

    async def stream(self, messages, max_tokens=320):
        yield "Call notes."


class Sink:
    def __init__(self):
        self.events = []

    async def __call__(self, message):
        self.events.append(message)

    def of(self, kind):
        return [e for e in self.events if e["type"] == kind]

    async def until(self, predicate, timeout=4.0):
        end = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < end:
            if predicate():
                return True
            await asyncio.sleep(0.01)
        return predicate()


class RealtimeCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(calls, "ROOT", Path(self.temp.name)), patch.object(calls, "Conversation", FakeConversation)]
        for item in self.patches:
            item.start()
        calls._calls.clear()
        calls._summaries.clear()
        calls._locks.clear()
        calls._feeds.clear()
        self.mocks = []
        self.account = "rt" + uuid.uuid4().hex[:6]
        accounts.set_current(self.account)        # the test's own context; every test starts in a new account
        self.endpoints = {name: model_endpoints.create_endpoint(f"{name} voice", URLS[name], "", KEYS[name], kind="api")["id"]
                          for name in KEYS}
        self.agent = agent_service.create("Voice " + uuid.uuid4().hex[:10], endpoint_id=None)
        parent = session_manager.create_session(owner_user="david")["id"]
        value = session_manager.get_session(parent)
        value["agent_id"] = self.agent["id"]
        value["model_endpoint_id"] = "strong"
        store.save_session(value)
        session_manager.append_message(parent, "user", "We were talking about the parkour course.")
        self.parent = parent
        self.call = calls.require(calls.start(parent, self.agent["id"], "fast", "small", "david")["id"], "david")

    async def asyncTearDown(self):
        pending = [task for task in calls._summaries.values() if not task.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        calls._summaries.clear()
        calls._feeds.clear()
        for session in list(realtime_session.SESSIONS.values()):
            await session.close()
        for mock in self.mocks:
            await mock.stop()
        realtime_voice.BASE_OVERRIDE.clear()
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    async def provider(self, name, **kwargs):
        mock = await MockRealtime(name, **kwargs).start()
        self.mocks.append(mock)
        realtime_voice.BASE_OVERRIDE[name] = mock.url
        return mock

    async def session(self, name, grace=0.05, clock=None, call=None):
        mock = await self.provider(name)
        sink = Sink()
        kwargs = {"truncate_grace": grace, **({"clock": clock} if clock else {})}
        session = realtime_session.RealtimeSession(call or self.call, self.endpoints[name], "", sink, **kwargs)
        await session.start()
        return mock, sink, session


class SetupTests(RealtimeCase):
    async def test_openai_session_setup(self):
        mock, sink, session = await self.session("openai")
        self.assertEqual(sink.of("ready")[0]["provider"], "openai")
        self.assertTrue(mock.path.startswith("/"))
        self.assertIn("model=gpt-realtime", mock.path)
        self.assertEqual(mock.headers["authorization"], f"Bearer {KEYS['openai']}")
        update = mock.received[0]["session"]
        self.assertEqual(update["audio"]["input"]["format"], {"type": "audio/pcm", "rate": 24000})
        self.assertEqual(update["audio"]["input"]["turn_detection"]["type"], "semantic_vad")
        self.assertEqual(update["audio"]["output"]["voice"], "marin")
        self.assertEqual([t["name"] for t in update["tools"]], ["do_work"])
        self.assertIn("parkour course", update["instructions"])        # the chat's own context travels with the call
        self.assertIn("do_work", update["instructions"])
        self.assertEqual(self.call["mode"], "realtime")
        self.assertEqual(self.call["realtime"]["provider"], "openai")

    async def test_xai_session_setup(self):
        mock, sink, session = await self.session("xai")
        self.assertIn("model=grok-voice-latest", mock.path)
        self.assertEqual(mock.headers["authorization"], f"Bearer {KEYS['xai']}")
        update = mock.received[0]["session"]
        self.assertEqual(update["audio"]["input"]["turn_detection"]["type"], "server_vad")
        self.assertEqual(update["audio"]["output"]["voice"], "ara")
        self.assertFalse(sink.of("ready")[0]["verified"])                 # flagged: never tried against the real service

    async def test_gemini_session_setup_sends_setup_first_and_keeps_the_key_out_of_the_url(self):
        mock, sink, session = await self.session("gemini")
        setup = mock.received[0]["setup"]
        self.assertEqual(setup["model"], "models/gemini-3.1-flash-live-preview")
        self.assertEqual(setup["generationConfig"]["responseModalities"], ["AUDIO"])
        self.assertEqual(setup["tools"][0]["functionDeclarations"][0]["name"], "do_work")
        self.assertEqual(mock.headers["x-goog-api-key"], KEYS["gemini"])
        self.assertNotIn(KEYS["gemini"], mock.path)

    async def test_model_and_voice_are_configurable(self):
        model_endpoints.set_realtime(self.endpoints["xai"], "xai", "grok-voice-custom")
        mock = await self.provider("xai")
        session = realtime_session.RealtimeSession(self.call, self.endpoints["xai"], "rex", Sink())
        await session.start()
        self.assertIn("model=grok-voice-custom", mock.path)
        self.assertEqual(mock.received[0]["session"]["audio"]["output"]["voice"], "rex")
        with self.assertRaises(ValueError):
            model_endpoints.set_realtime(self.endpoints["xai"], "nope")

    async def test_a_provider_that_never_answers_fails_cleanly(self):
        mock = await self.provider("openai", auto_ready=False)
        session = realtime_session.RealtimeSession(self.call, self.endpoints["openai"], "", Sink())
        with patch.object(realtime_session, "READY_SECONDS", 0.2), self.assertRaises(asyncio.TimeoutError):
            await session.start()
        self.assertNotIn(self.call["id"], realtime_session.SESSIONS)


class AudioTests(RealtimeCase):
    async def test_openai_input_is_resampled_to_24k_and_framed(self):
        mock, sink, session = await self.session("openai")
        await session.send_audio(tone16(200), 16000)                     # 200 ms at 16 kHz = 6400 bytes
        sent = await mock.wait_for(lambda m: m.get("type") == "input_audio_buffer.append")
        pcm = base64.b64decode(sent["audio"])
        self.assertAlmostEqual(len(pcm) / 2 / 24000, 0.2, delta=0.01)    # same 200 ms, now at 24 kHz
        samples = phone_audio.pcm16_to_float(pcm)
        crossings = int(np.sum(np.diff(np.signbit(samples).astype(int)) != 0))
        self.assertAlmostEqual(crossings / 2 / 0.2, 300, delta=25)       # still a 300 Hz tone

    async def test_gemini_input_stays_16k_with_its_mime_type(self):
        mock, sink, session = await self.session("gemini")
        await session.send_audio(tone16(200), 16000)
        sent = await mock.wait_for(lambda m: "realtimeInput" in m)
        audio = sent["realtimeInput"]["audio"]
        self.assertEqual(audio["mimeType"], "audio/pcm;rate=16000")
        self.assertEqual(len(base64.b64decode(audio["data"])), 6400)

    async def test_output_audio_reaches_the_sink_with_its_rate_and_item(self):
        mock, sink, session = await self.session("openai")
        pcm = tone16(100, 24000)
        await mock.push(openai_audio(pcm, "itemA"))
        self.assertTrue(await sink.until(lambda: sink.of("audio")))
        event = sink.of("audio")[0]
        self.assertEqual((event["rate"], event["item_id"]), (24000, "itemA"))
        self.assertEqual(base64.b64decode(event["data"]), pcm)

    async def test_gemini_output_arrives_even_in_binary_frames(self):
        mock, sink, session = await self.session("gemini")
        await mock.push_bytes(gemini_audio(tone16(100, 24000)))
        self.assertTrue(await sink.until(lambda: sink.of("audio")))

    async def test_a_muted_microphone_sends_nothing(self):
        mock, sink, session = await self.session("openai")
        session.muted = True
        await session.send_audio(tone16(100), 16000)
        await asyncio.sleep(0.1)
        self.assertEqual(mock.of_type("input_audio_buffer.append"), [])

    async def test_transcripts_are_kept_for_the_summary(self):
        mock, sink, session = await self.session("openai")
        await mock.push({"type": "conversation.item.input_audio_transcription.completed", "transcript": "Build me a course."})
        await mock.push(openai_text("Sure, "))
        await mock.push(openai_text("on it."))
        self.assertTrue(await sink.until(lambda: len(sink.of("assistant_text")) == 2))
        self.assertEqual([(m["role"], m["content"]) for m in self.call["messages"]],
                         [("user", "Build me a course."), ("assistant", "Sure, on it.")])


class HandoffTests(RealtimeCase):
    def fake_work(self, status="done", text="Found 3 files."):
        def delegate(call, title, request, key):
            job = {"task_id": "task-" + uuid.uuid4().hex[:6], "title": title, "key": key, "request": request}
            call["jobs"].append(job)
            return job
        task = {"status": status, "comments": [{"kind": "result", "text": text}]}
        return (patch.object(calls, "delegate", delegate), patch.object(calls.task_service, "get_task", lambda ident: task))

    async def test_openai_do_work_round_trip(self):
        first, second = self.fake_work()
        with first, second:
            mock, sink, session = await self.session("openai")
            await mock.push({"type": "response.created"})
            await mock.push(openai_tool("call_1", {"title": "Find files", "request": "Find the parkour files in my vault."}))
            await asyncio.sleep(0.1)
            # the answer to a tool call waits for the model to finish its turn
            self.assertEqual(mock.of_type("conversation.item.create"), [])
            await mock.push({"type": "response.done", "response": {"usage": {}}})
            output = await mock.wait_for(lambda m: m.get("item", {}).get("type") == "function_call_output")
            self.assertEqual(output["item"]["call_id"], "call_1")
            self.assertIn("Do not claim it is complete", output["item"]["output"])
            await mock.wait_for(lambda m: m.get("type") == "response.create")
            job = self.call["jobs"][0]
            self.assertEqual(job["title"], "Find files")
            self.assertEqual(sink.of("work")[0]["status"], "running")
            # the work finishes: the push channel tells the model, which is asked to say it
            await mock.push({"type": "response.done", "response": {}})
            before = len(mock.of_type("response.create"))
            await sink.until(lambda: calls._feeds.get(self.call["id"]))
            calls.publish(self.call, {"type": "work", "task_id": job["task_id"], "status": "done"})
            told = await mock.wait_for(lambda m: m.get("item", {}).get("role") == "system")
            self.assertIn("Found 3 files.", told["item"]["content"][0]["text"])
            await sink.until(lambda: len(mock.of_type("response.create")) > before)
            self.assertGreater(len(mock.of_type("response.create")), before)
            self.assertEqual(sink.of("work")[-1]["status"], "done")

    async def test_the_same_tool_call_is_not_run_twice(self):
        first, second = self.fake_work()
        with first, second:
            mock, sink, session = await self.session("openai")
            for _ in range(2):
                await mock.push(openai_tool("dup", {"title": "T", "request": "Do it please."}))
            await asyncio.sleep(0.15)
            self.assertEqual(len(self.call["jobs"]), 1)

    async def test_gemini_tool_call_is_answered_in_the_same_turn(self):
        first, second = self.fake_work()
        with first, second:
            mock, sink, session = await self.session("gemini")
            await mock.push({"toolCall": {"functionCalls": [{"id": "g1", "name": "do_work", "args": {"title": "Look up", "request": "Look up the price."}}]}})
            reply = await mock.wait_for(lambda m: "toolResponse" in m)
            response = reply["toolResponse"]["functionResponses"][0]
            self.assertEqual((response["id"], response["name"]), ("g1", "do_work"))
            self.assertIn("started", response["response"]["output"])
            self.assertEqual(len(self.call["jobs"]), 1)

    async def test_a_task_that_cannot_start_is_reported_to_the_model_not_hidden(self):
        mock, sink, session = await self.session("openai")
        await mock.push(openai_tool("c2", {"title": "x", "request": ""}))
        await mock.push({"type": "response.done", "response": {}})
        output = await mock.wait_for(lambda m: m.get("item", {}).get("type") == "function_call_output")
        self.assertIn("No task was given", output["item"]["output"])
        self.assertEqual(self.call["jobs"], [])


class InterruptionTests(RealtimeCase):
    async def speak_a_reply(self, mock, sink, item="itemX", chunks=3):
        await mock.push({"type": "response.created"})
        await mock.push(openai_text("This is a fairly long answer that the person will cut off. ", item))
        for _ in range(chunks):
            await mock.push(openai_audio(tone16(100, 24000), item))             # 3 x 100 ms = 300 ms sent
        self.assertTrue(await sink.until(lambda: len(sink.of("audio")) == chunks))

    async def test_speech_started_stops_playback_at_once_and_truncates_to_what_was_played(self):
        mock, sink, session = await self.session("openai", grace=5)
        await self.speak_a_reply(mock, sink)
        await mock.push({"type": "input_audio_buffer.speech_started"})
        self.assertTrue(await sink.until(lambda: sink.of("speech_started")))
        self.assertEqual(sink.of("speech_started")[0]["item_id"], "itemX")
        self.assertEqual(sink.of("speech_started")[0]["sent_ms"], 300)
        await session.played("itemX", 120)                                      # the browser: "only 120 ms were heard"
        cut = await mock.wait_for(lambda m: m.get("type") == "conversation.item.truncate")
        self.assertEqual((cut["item_id"], cut["audio_end_ms"], cut["content_index"]), ("itemX", 120, 0))
        message = self.call["messages"][-1]
        self.assertTrue(message["interrupted"])
        self.assertLess(len(message["content"]), len("This is a fairly long answer that the person will cut off. "))
        self.assertTrue("This is a fairly long answer that the person will cut off.".startswith(message["content"]))

    async def test_played_can_never_exceed_what_was_sent(self):
        mock, sink, session = await self.session("openai", grace=5)
        await self.speak_a_reply(mock, sink)
        await mock.push({"type": "input_audio_buffer.speech_started"})
        await sink.until(lambda: sink.of("speech_started"))
        await session.played("itemX", 99999)
        cut = await mock.wait_for(lambda m: m.get("type") == "conversation.item.truncate")
        self.assertEqual(cut["audio_end_ms"], 300)

    async def test_if_the_client_never_reports_the_server_truncates_by_the_clock(self):
        now = [100.0]
        mock, sink, session = await self.session("openai", grace=0.05, clock=lambda: now[0])
        await self.speak_a_reply(mock, sink)
        now[0] += 0.2
        await mock.push({"type": "input_audio_buffer.speech_started"})
        await sink.until(lambda: sink.of("speech_started"))
        now[0] += 0.0
        cut = await mock.wait_for(lambda m: m.get("type") == "conversation.item.truncate")
        self.assertLessEqual(cut["audio_end_ms"], 300)

    async def test_an_old_item_report_does_not_truncate_a_newer_one(self):
        mock, sink, session = await self.session("openai", grace=5)
        await self.speak_a_reply(mock, sink)
        await mock.push({"type": "input_audio_buffer.speech_started"})
        await sink.until(lambda: sink.of("speech_started"))
        await session.played("some-other-item", 50)
        await asyncio.sleep(0.1)
        self.assertEqual(mock.of_type("conversation.item.truncate"), [])
        self.assertIsNotNone(session.pending)

    async def test_gemini_interruption_stops_the_client_and_sends_no_truncate(self):
        mock, sink, session = await self.session("gemini", grace=0.05)
        await mock.push(gemini_audio(tone16(100, 24000)))
        await mock.push({"serverContent": {"outputTranscription": {"text": "Let me tell you about it at length"}}})
        await sink.until(lambda: sink.of("audio") and sink.of("assistant_text"))
        await mock.push({"serverContent": {"interrupted": True}})
        self.assertTrue(await sink.until(lambda: sink.of("speech_started")))
        await asyncio.sleep(0.2)
        self.assertEqual([m for m in mock.received if "conversation.item.truncate" in json.dumps(m)], [])
        self.assertTrue(self.call["messages"][-1]["interrupted"])

    async def test_speech_while_idle_is_just_an_event(self):
        mock, sink, session = await self.session("openai")
        await mock.push({"type": "input_audio_buffer.speech_started"})
        self.assertTrue(await sink.until(lambda: sink.of("speech_started")))
        await asyncio.sleep(0.1)
        self.assertEqual(mock.of_type("conversation.item.truncate"), [])


class FakeWS:
    """Starlette's WebSocket as the browser route sees it."""

    def __init__(self, headers=None):
        self.headers = {"host": "localhost:8420", **(headers or {})}
        self.inbound, self.sent, self.closed, self.accepted = asyncio.Queue(), [], None, False

    async def accept(self):
        self.accepted = True

    def say(self, **message):
        self.inbound.put_nowait({"type": "websocket.receive", "text": json.dumps(message)})

    def audio(self, pcm):
        self.inbound.put_nowait({"type": "websocket.receive", "bytes": pcm})

    def hang_up(self):
        self.inbound.put_nowait({"type": "websocket.disconnect"})

    async def receive_text(self):
        return (await self.inbound.get())["text"]

    async def receive(self):
        return await self.inbound.get()

    async def send_text(self, text):
        self.sent.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = code

    def of(self, kind):
        return [m for m in self.sent if m["type"] == kind]


class BrowserRouteTests(RealtimeCase):
    async def run_route(self, socket, user="david", ident=None):
        with patch.object(call_routes, "get_current_user", lambda conn: user):
            return await call_routes.realtime(socket, ident or self.call["id"])

    async def test_a_full_browser_session_never_sees_the_key(self):
        mock = await self.provider("openai")
        socket = FakeWS()
        socket.say(type="start", endpoint_id=self.endpoints["openai"], voice="cedar", consent=True)
        route = asyncio.create_task(self.run_route(socket))
        await mock.connected.wait()
        for _ in range(100):
            if socket.of("ready"):
                break
            await asyncio.sleep(0.02)
        self.assertTrue(socket.of("ready"))
        socket.audio(tone16(100))
        await mock.wait_for(lambda m: m.get("type") == "input_audio_buffer.append")
        await mock.push(openai_audio(tone16(100, 24000)))
        await mock.push({"type": "error", "error": {"message": f"Incorrect API key provided: {KEYS['openai']}"}})
        for _ in range(100):
            if socket.of("audio") and socket.of("error"):
                break
            await asyncio.sleep(0.02)
        socket.hang_up()
        await asyncio.wait_for(route, 5)
        everything = json.dumps(socket.sent)
        for key in KEYS.values():
            self.assertNotIn(key, everything)
        self.assertNotIn("Incorrect API key", everything)               # a provider error that echoes the key is replaced
        self.assertEqual(socket.of("ready")[0]["voice"], "cedar")
        self.assertTrue(self.call["ended"])                              # leaving the call ends it, as cloud mode does
        raw = json.dumps(calls.view(self.call)) + Path(calls._path(self.call["id"])).read_text(encoding="utf-8")
        for key in KEYS.values():
            self.assertNotIn(key, raw)

    async def test_the_paid_consent_is_required(self):
        socket = FakeWS()
        socket.say(type="start", endpoint_id=self.endpoints["openai"], voice="marin", consent=False)
        await self.run_route(socket)
        self.assertIn("paid", socket.of("error")[0]["message"])
        self.assertNotIn(self.call["id"], realtime_session.SESSIONS)

    async def test_strangers_and_foreign_origins_are_refused_before_accept(self):
        socket = FakeWS()
        await self.run_route(socket, user=None)
        self.assertEqual((socket.accepted, socket.closed), (False, 1008))
        socket = FakeWS(headers={"origin": "https://evil.example"})
        await self.run_route(socket)
        self.assertEqual((socket.accepted, socket.closed), (False, 1008))
        socket = FakeWS()
        await self.run_route(socket, user="mallory")
        self.assertEqual((socket.accepted, socket.closed), (False, 1008))

    async def test_a_connection_that_is_not_a_realtime_one_is_refused(self):
        plain = model_endpoints.create_endpoint("Some host", "https://models.example.net/v1", "m", "k", kind="api")["id"]
        socket = FakeWS()
        socket.say(type="start", endpoint_id=plain, voice="", consent=True)
        await self.run_route(socket)
        self.assertIn("Settings > Models", socket.of("error")[0]["message"])

    async def test_the_browser_report_of_played_audio_truncates(self):
        mock = await self.provider("openai")
        socket = FakeWS()
        socket.say(type="start", endpoint_id=self.endpoints["openai"], voice="", consent=True)
        route = asyncio.create_task(self.run_route(socket))
        for _ in range(100):
            if socket.of("ready"):
                break
            await asyncio.sleep(0.02)
        await mock.push({"type": "response.created"})
        await mock.push(openai_text("A long reply that will be cut short by the person talking.", "itemQ"))
        for _ in range(4):
            await mock.push(openai_audio(tone16(100, 24000), "itemQ"))
        for _ in range(100):
            if len(socket.of("audio")) == 4:
                break
            await asyncio.sleep(0.02)
        await mock.push({"type": "input_audio_buffer.speech_started"})
        for _ in range(100):
            if socket.of("speech_started"):
                break
            await asyncio.sleep(0.02)
        socket.say(type="played", item_id="itemQ", ms=150)
        cut = await mock.wait_for(lambda m: m.get("type") == "conversation.item.truncate")
        self.assertEqual(cut["audio_end_ms"], 150)
        socket.hang_up()
        await asyncio.wait_for(route, 5)


class AccountTests(RealtimeCase):
    async def test_keys_belong_to_their_account(self):
        other = "rt" + uuid.uuid4().hex[:6]
        with accounts.as_account(other):
            other_endpoint = model_endpoints.create_endpoint("Mine", URLS["openai"], "", "sk-OTHER-account-key", kind="api")["id"]
            self.assertEqual([c["id"] for c in realtime_session.choices()], [other_endpoint])
        mine = {c["id"] for c in realtime_session.choices()}
        self.assertEqual(mine, set(self.endpoints.values()))
        self.assertNotIn(other_endpoint, mine)
        # a session opened for this account uses this account's key
        mock = await self.provider("openai")
        session = realtime_session.RealtimeSession(self.call, self.endpoints["openai"], "", Sink())
        await session.start()
        self.assertEqual(mock.headers["authorization"], f"Bearer {KEYS['openai']}")
        # and the other account's connection cannot be opened from here
        with self.assertRaises(ValueError):
            realtime_session.RealtimeSession(self.call, other_endpoint, "", Sink())

    async def test_choices_carry_no_key_and_no_address(self):
        choices = realtime_session.choices()
        text = json.dumps(choices)
        for key in KEYS.values():
            self.assertNotIn(key, text)
        self.assertNotIn("api.openai.com", text)
        self.assertEqual({c["provider"] for c in choices}, {"openai", "xai", "gemini"})
        self.assertTrue(all("price_per_minute" in c and "voices" in c for c in choices))

    async def test_a_custom_host_needs_the_realtime_mark_and_a_key(self):
        custom = model_endpoints.create_endpoint("Proxy", "https://proxy.example.net/v1", "", "k-123", kind="api")["id"]
        self.assertNotIn(custom, {c["id"] for c in realtime_session.choices()})
        model_endpoints.set_realtime(custom, "openai")
        self.assertIn(custom, {c["id"] for c in realtime_session.choices()})
        keyless = model_endpoints.create_endpoint("Keyless", "https://api.openai.com/v1", "", None, kind="api")["id"]
        self.assertNotIn(keyless, {c["id"] for c in realtime_session.choices()})

    async def test_settings_are_per_account_and_per_bot(self):
        realtime_settings.update(self.endpoints["openai"], "cedar")
        realtime_settings.update(self.endpoints["xai"], "rex", bot_id="bot1")
        self.assertEqual(realtime_settings.for_bot("bot1"), {"endpoint_id": self.endpoints["xai"], "voice": "rex"})
        self.assertEqual(realtime_settings.for_bot("bot2"), {"endpoint_id": self.endpoints["openai"], "voice": "cedar"})
        with accounts.as_account("rt" + uuid.uuid4().hex[:6]):
            self.assertEqual(realtime_settings.for_bot("bot1"), {"endpoint_id": None, "voice": None})
        with self.assertRaises(ValueError):
            realtime_settings.update("bad id!")


class UsageTests(RealtimeCase):
    async def test_minutes_and_cost_are_counted_per_account(self):
        now = [1000.0]
        mock, sink, session = await self.session("openai", clock=lambda: now[0])
        now[0] += 90
        await session.close()
        row = realtime_usage.summary()["providers"]["openai"]
        self.assertEqual((row["seconds"], row["calls"], row["minutes"]), (90.0, 1, 1.5))
        self.assertAlmostEqual(row["cost_estimate"], 1.5 * realtime_voice.adapter("openai").price_per_minute, places=3)
        self.assertEqual(self.call["realtime"]["seconds"], 90.0)
        self.assertEqual(calls.view(self.call)["realtime"]["provider"], "openai")
        with accounts.as_account("rt" + uuid.uuid4().hex[:6]):
            self.assertEqual(realtime_usage.summary()["minutes"], 0)
        await session.close()                                                    # a second close counts nothing more
        self.assertEqual(realtime_usage.summary()["providers"]["openai"]["calls"], 1)

    async def test_ending_the_call_closes_the_provider_session_and_counts_it(self):
        now = [0.0]
        mock, sink, session = await self.session("xai", clock=lambda: now[0])
        now[0] += 30
        await realtime_session.close_for(self.call)
        self.assertTrue(session.closed)
        self.assertEqual(realtime_usage.summary()["providers"]["xai"]["seconds"], 30.0)


class RouteTests(RealtimeCase):
    async def test_choices_settings_and_usage_routes(self):
        app = FastAPI()
        app.include_router(call_routes.router)
        app.dependency_overrides[require_user] = lambda: "david"
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            choices = (await client.get("/api/agent-calls/realtime-choices")).json()
            self.assertEqual({c["provider"] for c in choices}, {"openai", "xai", "gemini"})
            saved = await client.put("/api/agent-calls/realtime-settings", json={"endpoint_id": self.endpoints["gemini"], "voice": "Kore"})
            self.assertEqual(saved.json()["endpoint_id"], self.endpoints["gemini"])
            bad = await client.put("/api/agent-calls/realtime-settings", json={"endpoint_id": "no way!"})
            self.assertEqual(bad.status_code, 422)
            usage = (await client.get("/api/agent-calls/realtime-usage")).json()
            self.assertEqual(usage["minutes"], 0)


class AdapterTests(unittest.TestCase):
    def test_providers_are_found_by_official_host_only(self):
        self.assertEqual(realtime_voice.provider_for_url("https://api.openai.com/v1"), "openai")
        self.assertEqual(realtime_voice.provider_for_url("https://api.x.ai/v1"), "xai")
        self.assertEqual(realtime_voice.provider_for_url("https://generativelanguage.googleapis.com/v1beta"), "gemini")
        self.assertIsNone(realtime_voice.provider_for_url("https://api.openai.com.evil.net/v1"))
        self.assertIsNone(realtime_voice.provider_for_url("http://localhost:11434/v1"))

    def test_unparseable_provider_frames_are_ignored(self):
        for adapter in realtime_voice.ADAPTERS.values():
            self.assertEqual(adapter.parse("not json"), [])
            self.assertEqual(adapter.parse(b"\xff\xfe"), [])
            self.assertEqual(adapter.parse("[1,2]"), [])

    def test_gemini_turn_parses_into_normalized_events(self):
        adapter = realtime_voice.adapter("gemini")
        events = adapter.parse(json.dumps({"serverContent": {"inputTranscription": {"text": "hi"}, "outputTranscription": {"text": "hello"},
                                                             "turnComplete": True}}))
        self.assertEqual([e["type"] for e in events], ["user_text", "assistant_text", "turn_done"])


# -- the phone bridge in realtime mode ----------------------------------------------------------------------

class PhoneSocket:
    def __init__(self, messages=(), stop_when=None):
        self.queue = asyncio.Queue()
        for message in messages:
            self.queue.put_nowait(message)
        self.sent, self.stop_when = [], stop_when

    async def recv(self):
        if self.queue.empty():
            for _ in range(400):
                if self.stop_when and self.stop_when():
                    return None
                try:
                    return await asyncio.wait_for(self.queue.get(), 0.01)
                except asyncio.TimeoutError:
                    continue
            return None
        return await self.queue.get()

    async def send(self, text):
        self.sent.append(json.loads(text))

    def media(self):
        return [m for m in self.sent if m.get("event") == "media"]

    def clears(self):
        return [m for m in self.sent if m.get("event") == "clear"]


def twilio_media(frame):
    return json.dumps({"event": "media", "media": {"track": "inbound", "payload": base64.b64encode(frame).decode()}})


class PhoneRealtimeTests(RealtimeCase):
    def bridge(self, socket, mock_name="openai", clock=None, **kwargs):
        provider = Twilio({}, {})
        return realtime_phone.RealtimePhoneBridge(provider, socket.send, self.call, self.endpoints[mock_name], "", stream_id="MZ1",
                                                  pace=False, truncate_grace=5, **({"clock": clock} if clock else {}), **kwargs)

    async def test_caller_audio_goes_up_resampled_and_the_models_audio_comes_back_as_20ms_mulaw_frames(self):
        mock = await self.provider("openai")
        tone8k = (0.3 * np.sin(2 * np.pi * 300 * np.arange(8000 // 5) / 8000)).astype(np.float32)           # 200 ms
        mulaw = phone_audio.mulaw_encode(tone8k)
        frames = [mulaw[i:i + 160] for i in range(0, len(mulaw) - 159, 160)]
        socket = PhoneSocket([twilio_media(f) for f in frames], stop_when=lambda: len(socket.media()) >= 15)
        bridge = self.bridge(socket)
        run = asyncio.create_task(bridge.run(socket.recv))
        await mock.wait_for(lambda m: m.get("type") == "input_audio_buffer.append")
        await asyncio.sleep(0.1)
        sent = sum(len(base64.b64decode(m["audio"])) for m in mock.of_type("input_audio_buffer.append"))
        self.assertAlmostEqual(sent / 2 / 24000, 0.2, delta=0.03)             # 8 kHz mu-law in, 24 kHz PCM16 to the provider
        await mock.push(openai_audio(tone16(300, 24000), "p1"))                  # 300 ms back
        for _ in range(200):
            if len(socket.media()) >= 15:
                break
            await asyncio.sleep(0.02)
        await asyncio.wait_for(run, 5)
        media = socket.media()
        self.assertEqual(len(media), 15)
        payloads = [base64.b64decode(m["media"]["payload"]) for m in media]
        self.assertTrue(all(len(p) == 160 for p in payloads))
        self.assertTrue(all(m["streamSid"] == "MZ1" for m in media))
        self.assertGreater(max(float(np.abs(phone_audio.mulaw_decode(p)).max()) for p in payloads), 3000)

    async def test_the_opening_line_is_given_to_the_model_to_say(self):
        mock = await self.provider("openai")
        socket = PhoneSocket(stop_when=lambda: True)
        bridge = self.bridge(socket, opening="This is Kip, an AI assistant from Kairos.")
        await bridge.run(socket.recv)
        told = await mock.wait_for(lambda m: m.get("item", {}).get("role") == "system")
        self.assertIn("This is Kip, an AI assistant from Kairos.", told["item"]["content"][0]["text"])

    async def test_the_caller_talking_over_the_bot_clears_the_line_and_truncates_to_what_was_played(self):
        mock = await self.provider("openai")
        now = [50.0]
        socket = PhoneSocket(stop_when=lambda: bool(mock.of_type("conversation.item.truncate")))
        bridge = self.bridge(socket, clock=lambda: now[0])
        run = asyncio.create_task(bridge.run(socket.recv))
        await mock.connected.wait()
        await asyncio.sleep(0.1)
        await mock.push({"type": "response.created"})
        await mock.push(openai_text("A long answer for the phone.", "ph1"))
        await mock.push(openai_audio(tone16(500, 24000), "ph1"))                 # 500 ms = 25 frames
        for _ in range(200):
            if len(socket.media()) >= 25:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(len(socket.media()), 25)
        now[0] += 0.12                                                          # 120 ms of it has actually been playing
        await mock.push({"type": "input_audio_buffer.speech_started"})
        cut = await mock.wait_for(lambda m: m.get("type") == "conversation.item.truncate")
        self.assertEqual(cut["item_id"], "ph1")
        self.assertEqual(cut["audio_end_ms"], 120)
        self.assertEqual(len(socket.clears()), 1)
        self.assertEqual(socket.clears()[0]["streamSid"], "MZ1")
        await asyncio.wait_for(run, 5)
        self.assertTrue(self.call["messages"][-1]["interrupted"])

    async def test_audio_queued_but_not_yet_sent_is_dropped_on_barge_in(self):
        mock = await self.provider("openai")
        gate = asyncio.Event()
        socket = PhoneSocket(stop_when=lambda: bool(socket.clears()))
        bridge = self.bridge(socket)
        original = bridge.send_text

        async def slow(text):
            if json.loads(text).get("event") == "media" and bridge.sent_frames >= 5:
                await gate.wait()
            await original(text)
        bridge.send_text = slow
        run = asyncio.create_task(bridge.run(socket.recv))
        await mock.connected.wait()
        await asyncio.sleep(0.1)
        await mock.push(openai_audio(tone16(1000, 24000), "ph2"))               # 50 frames, only about 5 get out
        await asyncio.sleep(0.3)
        await mock.push({"type": "input_audio_buffer.speech_started"})
        await asyncio.sleep(0.2)
        gate.set()
        await asyncio.wait_for(run, 5)
        self.assertLess(len(socket.media()), 50)
        self.assertEqual(bridge.queue.qsize(), 0)

    async def test_serve_stream_runs_realtime_when_the_bot_is_set_to_it(self):
        from core import phone_connection as connection
        from services import phone_calls
        mock = await self.provider("openai")
        realtime_settings.update(self.endpoints["openai"], "marin")
        bot = {"id": self.agent["id"], "name": "Kip", "voice_id": None, "call_mode": "realtime"}
        connection.save({"provider": "twilio", "account_sid": "ACrt", "auth_token": "tok", "number": "+15550003333",
                         "user_number": "+15557770003", "public_url": "https://kairos.example.net",
                         "conversation_endpoint_id": "fast", "conversation_model": "small", "require_pin": False}, account=self.account)
        token = phone_calls.mint("stream", self.account, 60, mode="inbound", message="", bot_id=bot["id"])
        socket = PhoneSocket([json.dumps({"event": "start", "start": {"streamSid": "MZ9", "callSid": "CA9", "customParameters": {"t": token}}})],
                             stop_when=lambda: len(socket.media()) >= 3)
        socket.headers, socket.query = {}, {}

        async def close(code=1000):
            socket.closed = code
        socket.close = close

        class Opened:
            def __init__(self, call):
                self.call = call

            async def close(self):
                calls.end(self.call)

        async def factory(account, record, found, session):
            return Opened(self.call)

        class SkipSignature(Twilio):
            def verify_stream_handshake(self, headers):
                return None
        with patch.object(phone_calls, "bot_for", lambda account, record: bot), \
                patch.object(phone_calls, "provider_for", lambda account, record: SkipSignature(record, {})), \
                patch.object(phone_calls, "owner_of", lambda account: "david"):
            task = asyncio.create_task(phone_calls.serve_stream("twilio", socket, pipeline_factory=factory, bridge_options={"pace": False}))
            await mock.wait_for(lambda m: m.get("type") == "session.update")
            await asyncio.sleep(0.1)
            await mock.push(openai_audio(tone16(200, 24000), "s1"))
            result = await asyncio.wait_for(task, 8)
        self.assertEqual(result, "ended")
        self.assertGreaterEqual(len(socket.media()), 3)
        self.assertTrue(self.call["ended"])
        self.assertEqual(self.call["realtime"]["provider"], "openai")
        self.assertIn("Hi, it's Kip.", json.dumps(mock.received))               # the opening line went to the model

    async def test_without_the_bots_realtime_setting_or_a_valid_connection_the_local_path_is_kept(self):
        from services import phone_calls
        bot = {"id": self.agent["id"], "call_mode": "turns"}
        realtime_settings.update(self.endpoints["openai"], "marin")
        self.assertIsNone(phone_calls.realtime_choice(self.account, bot))
        self.assertIsNotNone(phone_calls.realtime_choice(self.account, {**bot, "call_mode": "realtime"}))
        realtime_settings.update("gone-endpoint", None)
        self.assertIsNone(phone_calls.realtime_choice(self.account, {**bot, "call_mode": "realtime"}))
        problem = await phone_calls.live_problem(self.account, {"conversation_endpoint_id": "e", "conversation_model": "m"}, {**bot, "call_mode": "turns"})
        self.assertNotEqual(problem, "")                                           # local still needs its speech setup


if __name__ == "__main__":
    unittest.main()
