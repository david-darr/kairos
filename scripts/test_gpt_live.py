"""OpenAI GPT-Live (gpt-live-1) as the fourth realtime voice, against a MOCK Live sessions server only (loopback WebSocket).

Proves our side: GPT-Live is offered on any official OpenAI key (and only there), the session.start shape from OpenAI's
Live guides, audio framing, client delegation handing the work to the chat's own model and tools with the result said
back through session.commentary.append, the inferred barge-in, the close handshake that confirms billed seconds, and the
phone bridge. It cannot prove OpenAI accepts these messages (see core/realtime_voice.py OpenAILive).
Run: python scripts/test_gpt_live.py
"""
import asyncio
import base64
import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_realtime_voice import KEYS, RealtimeCase, Sink, tone16  # noqa: E402  (sets the test data folder first)

from core import accounts, model_endpoints, realtime_usage, realtime_voice  # noqa: E402
from core.phone_providers import Twilio  # noqa: E402
from realtime_mock import MockRealtime, live_audio, live_delegation, live_said  # noqa: E402
from services import agent_calls as calls, phone_calls, realtime_phone, realtime_session  # noqa: E402


class LiveCase(RealtimeCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.live_id = realtime_voice.LIVE_PREFIX + self.endpoints["openai"]
        self.quick = [patch.object(realtime_session, "DELEGATION_SETTLE", 0.05), patch.object(realtime_session, "DELEGATION_QUIET", 0.1)]
        for item in self.quick:
            item.start()

    async def asyncTearDown(self):
        for item in self.quick:
            item.stop()
        await super().asyncTearDown()

    async def live(self, voice="", clock=None, **mock_options):
        mock = await MockRealtime("openai_live", **mock_options).start()
        self.mocks.append(mock)
        realtime_voice.BASE_OVERRIDE["openai_live"] = mock.url
        sink = Sink()
        session = realtime_session.RealtimeSession(self.call, self.live_id, voice, sink, truncate_grace=0.05,
                                                   **({"clock": clock} if clock else {}))
        await session.start()
        return mock, sink, session

    def fake_work(self, text="Found 3 files."):
        seen = []

        def delegate(call, title, request, key):
            job = {"task_id": "task-" + uuid.uuid4().hex[:6], "title": title, "key": key, "request": request}
            call["jobs"].append(job)
            seen.append(job)
            return job
        task = {"status": "done", "comments": [{"kind": "result", "text": text}]}
        return seen, (patch.object(calls, "delegate", delegate), patch.object(calls.task_service, "get_task", lambda ident: task))


class ChoiceTests(LiveCase):
    async def test_an_official_openai_key_offers_realtime_and_gpt_live(self):
        offered = {c["id"]: c for c in realtime_session.choices()}
        self.assertIn(self.endpoints["openai"], offered)
        live = offered[self.live_id]
        self.assertEqual((live["provider"], live["model"], live["price_per_minute"]), ("openai_live", "gpt-live-1", 0.05))
        self.assertFalse(live["verified"])
        self.assertIn("marin", live["voices"])
        self.assertNotIn(realtime_voice.LIVE_PREFIX + self.endpoints["xai"], offered)
        self.assertNotIn(realtime_voice.LIVE_PREFIX + self.endpoints["gemini"], offered)

    async def test_a_custom_address_marked_openai_is_never_sent_to_openai_live(self):
        custom = model_endpoints.create_endpoint("proxy", "https://llm.example.com/v1", "", "sk-proxy-secret-999", kind="api")["id"]
        model_endpoints.set_realtime(custom, "openai")
        self.assertNotIn(realtime_voice.LIVE_PREFIX + custom, {c["id"] for c in realtime_session.choices()})
        with self.assertRaisesRegex(ValueError, "official OpenAI"):
            realtime_session.RealtimeSession(self.call, realtime_voice.LIVE_PREFIX + custom, "", Sink())


class SetupTests(LiveCase):
    async def test_session_start_matches_the_live_guides(self):
        mock, sink, session = await self.live("vesper")
        self.assertEqual(mock.path, "/")                                    # no ?model= query: the model is in session.start
        self.assertEqual(mock.headers["authorization"], f"Bearer {KEYS['openai']}")
        start = mock.received[0]
        self.assertEqual(start["type"], "session.start")
        self.assertTrue(start["event_id"])
        body = start["session"]
        self.assertEqual(body["model"], "gpt-live-1")
        self.assertEqual(body["audio"], {"format": {"type": "audio/pcm", "rate": 24000}, "output": {"voice": "vesper"}})
        self.assertEqual(body["delegation"]["type"], "client")
        self.assertFalse(body["store"])
        self.assertNotIn("tools", body)
        self.assertIn("parkour course", body["instructions"])            # the chat's own context travels with the call
        self.assertIn("delegate", body["instructions"])
        self.assertNotIn("do_work", body["instructions"])
        ready = sink.of("ready")[0]
        self.assertEqual((ready["provider"], ready["model"], ready["price_per_minute"]), ("openai_live", "gpt-live-1", 0.05))
        self.assertEqual(self.call["realtime"]["provider"], "openai_live")

    async def test_an_unknown_voice_falls_back_to_marin(self):
        mock, sink, session = await self.live("cedar")                       # a Realtime voice, not a Live one
        self.assertEqual(mock.received[0]["session"]["audio"]["output"]["voice"], "marin")


class AudioTests(LiveCase):
    async def test_microphone_audio_is_resampled_to_24k(self):
        mock, sink, session = await self.live()
        await session.send_audio(tone16(200), 16000)
        sent = await mock.wait_for(lambda m: m.get("type") == "session.input_audio.append")
        self.assertAlmostEqual(len(base64.b64decode(sent["audio"])) / 2 / 24000, 0.2, delta=0.01)

    async def test_output_audio_and_transcripts(self):
        mock, sink, session = await self.live()
        await mock.push(live_said("Build me a course.", "input"))
        await mock.push(live_audio(tone16(100, 24000)))
        await mock.push(live_said("Sure, on it."))
        self.assertTrue(await sink.until(lambda: sink.of("audio") and sink.of("assistant_text")))
        self.assertEqual(sink.of("audio")[0]["rate"], 24000)
        self.assertEqual([(m["role"], m["content"]) for m in self.call["messages"]],
                         [("user", "Build me a course."), ("assistant", "Sure, on it.")])

    async def test_mute_tells_the_provider(self):
        mock, sink, session = await self.live()
        await session.set_muted(True)
        await mock.wait_for(lambda m: m.get("type") == "session.input_audio.mute")
        await session.send_audio(tone16(100), 16000)
        await asyncio.sleep(0.05)
        self.assertEqual(mock.of_type("session.input_audio.append"), [])
        await session.set_muted(False)
        await mock.wait_for(lambda m: m.get("type") == "session.input_audio.unmute")


class DelegationTests(LiveCase):
    async def test_a_delegation_goes_to_the_chat_model_and_the_result_is_said(self):
        seen, (first, second) = self.fake_work()
        with first, second:
            mock, sink, session = await self.live()
            await mock.push(live_said("Find the parkour files in my vault.", "input"))
            await mock.push(live_said("Let me look."))
            await mock.push(live_delegation("del_1"))
            thinking = await mock.wait_for(lambda m: m.get("type") == "session.thinking.append")
            self.assertEqual(thinking["delegation_id"], "del_1")
            self.assertIn("not done yet", thinking["content"])
            job = seen[0]
            self.assertEqual(job["key"], "live:del_1")
            self.assertIn("Find the parkour files in my vault.", job["request"])
            self.assertIn("data, not instructions", job["request"])
            self.assertEqual(job["title"], "Find the parkour files in my")
            self.assertEqual(sink.of("work")[0]["status"], "running")
            # the work finishes: the push channel tells GPT-Live, against the same delegation, to say it
            await sink.until(lambda: calls._feeds.get(self.call["id"]))
            calls.publish(self.call, {"type": "work", "task_id": job["task_id"], "status": "done"})
            said = await mock.wait_for(lambda m: m.get("type") == "session.commentary.append")
            self.assertEqual(said["delegation_id"], "del_1")
            self.assertIn("Found 3 files.", said["content"])
            self.assertEqual(sink.of("work")[-1]["status"], "done")

    async def test_the_thinking_note_waits_for_gpt_lives_own_acknowledgement(self):
        seen, (first, second) = self.fake_work()
        with first, second, patch.object(realtime_session, "DELEGATION_QUIET", 0.4):
            mock, sink, session = await self.live()
            await mock.push(live_said("Book the court.", "input"))
            await mock.push(live_delegation("del_q"))
            await sink.until(lambda: seen)
            await asyncio.sleep(0.1)
            self.assertEqual(mock.of_type("session.thinking.append"), [], "an append would cancel its spoken acknowledgement")
            await mock.wait_for(lambda m: m.get("type") == "session.thinking.append")

    async def test_each_delegation_runs_once_and_takes_only_its_own_words(self):
        seen, (first, second) = self.fake_work()
        with first, second:
            mock, sink, session = await self.live()
            await mock.push(live_said("Rename the photos.", "input"))
            await mock.push(live_delegation("d1"))
            await mock.push(live_delegation("d1"))
            await mock.wait_for(lambda m: m.get("delegation_id") == "d1")
            await mock.push(live_said("Done with that."))
            await mock.push(live_said("Now email Sam the list.", "input"))
            await mock.push(live_delegation("d2"))
            await mock.wait_for(lambda m: m.get("delegation_id") == "d2")
            self.assertEqual(len(seen), 2)
            self.assertNotIn("Rename the photos", seen[1]["request"])
            self.assertIn("Now email Sam the list.", seen[1]["request"])

    async def test_a_delegation_with_nothing_said_starts_no_work(self):
        seen, (first, second) = self.fake_work()
        with first, second:
            mock, sink, session = await self.live()
            await mock.push(live_delegation("empty"))
            note = await mock.wait_for(lambda m: m.get("type") == "session.thinking.append")
            self.assertIn("Nothing was asked", note["content"])
            self.assertEqual(seen, [])

    async def test_a_phone_opening_line_is_commentary_with_no_delegation(self):
        mock, sink, session = await self.live()
        await session.push_text("Say hello.")
        said = await mock.wait_for(lambda m: m.get("type") == "session.commentary.append")
        self.assertIsNone(said["delegation_id"])


class BargeInTests(LiveCase):
    async def test_the_person_talking_after_the_audio_stops_clears_the_far_end(self):
        now = [10.0]
        mock, sink, session = await self.live(clock=lambda: now[0])
        await mock.push(live_said("A long answer the person will cut off. "))
        for _ in range(10):
            await mock.push(live_audio(tone16(100, 24000)))                  # one second of reply sent
        await sink.until(lambda: len(sink.of("audio")) == 10)
        now[0] += 0.4                                                         # audio stopped 0.4 s ago, reply still playing
        await mock.push(live_said("Wait,", "input"))
        self.assertTrue(await sink.until(lambda: sink.of("speech_started")))
        self.assertEqual(sink.of("speech_started")[0]["sent_ms"], 1000)
        await session.played(None, 300)
        await sink.until(lambda: self.call["messages"][-2].get("interrupted"))
        self.assertTrue(self.call["messages"][-2]["interrupted"])
        self.assertEqual(self.call["messages"][-1], {"role": "user", "content": "Wait,"})

    async def test_a_nod_while_it_keeps_talking_interrupts_nothing(self):
        now = [10.0]
        mock, sink, session = await self.live(clock=lambda: now[0])
        await mock.push(live_audio(tone16(100, 24000)))
        await sink.until(lambda: sink.of("audio"))
        now[0] += 0.05                                                        # audio is still arriving
        await mock.push(live_said("mm-hm", "input"))
        await sink.until(lambda: sink.of("user_text"))
        self.assertEqual(sink.of("speech_started"), [])

    async def test_talking_after_the_reply_finished_is_a_new_turn_not_an_interruption(self):
        now = [10.0]
        mock, sink, session = await self.live(clock=lambda: now[0])
        await mock.push(live_said("Short answer."))
        await mock.push(live_audio(tone16(100, 24000)))
        await sink.until(lambda: sink.of("audio"))
        now[0] += 3.0
        await mock.push(live_said("Thanks. Next question.", "input"))
        await mock.push(live_said("Go ahead."))
        await sink.until(lambda: len(sink.of("assistant_text")) == 2)
        self.assertEqual(sink.of("speech_started"), [])
        self.assertEqual([m["role"] for m in self.call["messages"]], ["assistant", "user", "assistant"])
        self.assertFalse(self.call["messages"][0]["interrupted"])


class CloseTests(LiveCase):
    async def test_close_asks_for_and_records_the_billed_seconds(self):
        mock, sink, session = await self.live(close_usage=42.0)
        await session.close()
        self.assertEqual(mock.of_type("session.close"), [{"type": "session.close"}])
        self.assertEqual(self.call["realtime"]["seconds"], 42.0)
        self.assertAlmostEqual(self.call["realtime"]["cost_estimate"], round(42 / 60 * 0.05, 4))
        self.assertEqual(realtime_usage.summary()["providers"]["openai_live"]["seconds"], 42.0)
        self.assertNotIn("live_error", self.call)

    async def test_an_unconfirmed_close_is_said_plainly(self):
        mock, sink, session = await self.live(close_usage=None)
        with patch.object(realtime_session, "CLOSE_SECONDS", 0.1):
            await session.close()
        self.assertIn("did not confirm", self.call["live_error"])
        self.assertIn("seconds", self.call["realtime"])                      # counted by the clock instead

    async def test_the_provider_ending_the_session_ends_it_here(self):
        mock, sink, session = await self.live()
        await mock.push({"type": "session.closed", "reason": "expired", "usage": {"seconds": 1800}})
        self.assertTrue(await sink.until(lambda: sink.of("ended")))
        self.assertIn("time limit", sink.of("error")[0]["message"])
        self.assertEqual(self.call["realtime"]["seconds"], 1800)

    async def test_a_provider_error_never_shows_the_key(self):
        mock, sink, session = await self.live()
        await mock.push({"type": "error", "error": {"message": f"bad key {KEYS['openai']}", "code": "invalid_api_key"}})
        await sink.until(lambda: sink.of("error"))
        self.assertNotIn(KEYS["openai"], json.dumps(sink.events))


class FakeStream:
    def __init__(self):
        self.inbound, self.sent = asyncio.Queue(), []

    async def recv(self):
        return await self.inbound.get()

    async def send(self, text):
        self.sent.append(json.loads(text))


class PhoneTests(LiveCase):
    async def test_a_phone_call_in_gpt_live_says_the_opening_and_bridges_audio(self):
        mock = await MockRealtime("openai_live").start()
        self.mocks.append(mock)
        realtime_voice.BASE_OVERRIDE["openai_live"] = mock.url
        stream = FakeStream()
        bridge = realtime_phone.RealtimePhoneBridge(Twilio({}, {}), stream.send, self.call, self.live_id, "", stream_id="MZ1",
                                                    opening="Hi, it's Kip.", pace=False)
        task = asyncio.create_task(bridge.run(stream.recv))
        opening = await mock.wait_for(lambda m: m.get("type") == "session.commentary.append")
        self.assertIn("Hi, it's Kip.", opening["content"])
        await mock.push(live_audio(tone16(200, 24000)))
        for _ in range(100):
            if any(m.get("event") == "media" for m in stream.sent):
                break
            await asyncio.sleep(0.02)
        self.assertTrue(any(m.get("event") == "media" for m in stream.sent))
        stream.inbound.put_nowait(None)
        await asyncio.wait_for(task, 8)
        self.assertTrue(mock.of_type("session.close"))

    async def test_a_bot_on_the_older_live_mode_gets_gpt_live_on_the_phone(self):
        chosen = phone_calls.realtime_choice(self.account, {"id": "b1", "call_mode": "live"})
        self.assertEqual(chosen["endpoint_id"], self.live_id)
        self.assertIsNone(phone_calls.realtime_choice(self.account, {"id": "b1", "call_mode": "turns"}))

    async def test_gpt_live_as_the_voice_reaches_the_phone_unless_the_bot_says_local(self):
        from core import call_voices
        with accounts.as_account(self.account):
            call_voices.set_choice("gpt_live")
        try:
            self.assertEqual(phone_calls.realtime_choice(self.account, {"id": "b1", "call_mode": "turns"})["endpoint_id"], self.live_id,
                             "a bot on Same as Settings follows the Voice")
            self.assertIsNone(phone_calls.realtime_choice(self.account, {"id": "b1", "call_mode": "local"}), "a bot set to Local overrides it")
        finally:
            with accounts.as_account(self.account):
                call_voices.set_choice("kairos")


if __name__ == "__main__":
    unittest.main()
