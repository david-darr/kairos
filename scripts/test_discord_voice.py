"""Voice with a bot in a Discord voice channel (services/discord_voice.py), against fakes only: no Discord, no network,
no PyNaCl or libopus. A fake transport stands in for the voice connection, a fake codec for Opus, a fake pipeline for
speech-to-text, the model and the voice, and a fake clock steps time by hand.
MANUAL (needs the add-ons installed and a real server): a real bot joining a real voice channel, hearing the person's
voice, speaking back in Opus, DAVE encryption, barge-in over real latency. scripts/discord_voice_probe.py checks the
real receive path (DAVE opened, Opus decoded) and plays beeps; David runs it himself.

    .venv\\Scripts\\python.exe -X utf8 scripts\\test_discord_voice.py
"""
import asyncio
import importlib.util
import logging
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_DATA = tempfile.TemporaryDirectory(prefix="kairos-dvoice-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import numpy as np  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from core import bot_outbound, discord_bots_store as bots, discord_voice_audio as audio, phone_audio, settings as settings_store  # noqa: E402
from core.channels import discord_channel as dc  # noqa: E402
from services import discord_voice as dv, discord_voice_transport, phone_bridge, phone_tools  # noqa: E402

logging.disable(logging.CRITICAL)
OWNER, STRANGER = "9001", "9002"
VOICE_CHANNEL = "5550001"
AGENT = {"id": "bot-kip", "name": "Kip"}


def chunk(amp=0.3, freq=220, start=0, left_only=False) -> bytes:
    """20 ms of 48 kHz stereo PCM16."""
    n = np.arange(start, start + audio.FRAME_SAMPLES)
    wave = (np.sin(2 * np.pi * freq * n / audio.DISCORD_RATE) * amp * 32767).astype("<i2")
    right = np.zeros_like(wave) if left_only else wave
    return np.stack([wave, right], axis=1).reshape(-1).tobytes()


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeCodec:
    """Opus stand-in: a packet is b'OPUS' + the PCM it came from, so a test can see what was encoded and decoded."""
    def __init__(self):
        self.decoded = 0

    def encode(self, pcm):
        assert len(pcm) == audio.FRAME_BYTES
        return b"OPUS" + pcm[:8]

    def new_decoder(self):
        codec = self

        class Decoder:
            def decode(self, packet):
                codec.decoded += 1
                return packet[4:] + b"\x00" * (audio.FRAME_BYTES - len(packet[4:]))
        return Decoder()


class FakePipeline(phone_bridge.Pipeline):
    def __init__(self, reply="Hello to you, friend. How can I help today?", seconds=0.1, verdict=None):
        self.reply, self.seconds, self.verdict = reply, seconds, verdict
        self.transcribed, self.announced, self.spoken, self.interrupts, self.closed, self.touched = [], [], [], [], False, 0

    async def transcribe(self, pcm16):
        self.transcribed.append(len(pcm16))
        return "hello there"

    async def end_of_turn(self, pcm16):
        return self.verdict

    async def converse(self, text, request_id):
        for word in self.reply.split(" "):
            yield word + " "

    async def announce(self, text, request_id):
        self.announced.append(text)

    async def speak(self, text):
        self.spoken.append(text)
        count = int(24000 * self.seconds)
        yield 24000, (np.sin(np.arange(count) * 0.05) * 8000).astype("<i2").tobytes()

    def interrupt(self, spoken):
        self.interrupts.append(spoken)

    def touch(self):
        self.touched += 1

    async def close(self):
        self.closed = True


async def settle(rounds=60):
    for _ in range(rounds):
        await asyncio.sleep(0)


class Rig:
    """A bridge on a fake clock: quiet() and talk() move time and feed it, the way a real channel would."""
    def __init__(self, pipeline=None, pace=False, sleep=None, present=True, **options):
        self.clock, self.pipeline, self.codec = FakeClock(), pipeline or FakePipeline(), FakeCodec()
        self.sent, self.cleared = [], []
        extra = {"sleep": sleep} if sleep else {}
        self.bridge = phone_bridge_factory(self, pace, present, extra, options)

    async def begin(self):
        await self.bridge._begin()

    async def quiet(self, seconds):
        for _ in range(int(round(seconds / 0.02))):
            self.clock.t += 0.02
            await self.bridge.tick()
            await settle(3)
        await settle()

    async def talk(self, seconds, user=OWNER, amp=0.3):
        for index in range(int(round(seconds / 0.02))):
            self.clock.t += 0.02
            await self.bridge.handle(("audio", user, chunk(amp, start=index * audio.FRAME_SAMPLES)))
        await settle()


def phone_bridge_factory(rig, pace, present, extra, options):
    return dv.VoiceBridge(rig.pipeline, linked_user=OWNER, send=rig.sent.append, clear=lambda: rig.cleared.append(1),
                          codec=rig.codec, present=present, pace=pace, clock=rig.clock, **extra, **options)


async def never(_seconds):
    await asyncio.Event().wait()


class Audio(unittest.TestCase):
    def test_stereo_48k_becomes_mono_16k(self):
        converter = audio.DiscordToSpeech()
        total = b"".join(converter.feed(chunk(0.4, start=i * audio.FRAME_SAMPLES)) for i in range(50))   # 1 second
        samples = phone_audio.pcm16_to_float(total)
        self.assertLessEqual(abs(len(samples) - 16000), 4)
        self.assertAlmostEqual(float(np.max(np.abs(samples[2000:]))), 0.4, delta=0.03)

    def test_the_two_channels_are_averaged(self):
        converter = audio.DiscordToSpeech()
        left_only = b"".join(converter.feed(chunk(0.4, start=i * audio.FRAME_SAMPLES, left_only=True)) for i in range(50))
        self.assertAlmostEqual(float(np.max(np.abs(phone_audio.pcm16_to_float(left_only)[2000:]))), 0.2, delta=0.03)

    def test_an_odd_trailing_byte_is_ignored(self):
        self.assertEqual(len(audio.to_mono_float(chunk() + b"\x01")), audio.FRAME_SAMPLES)

    def test_speech_out_is_exact_20ms_stereo_frames_with_a_padded_tail(self):
        converter = audio.SpeechToDiscord(24000)
        pcm = (np.sin(np.arange(2400) * 0.05) * 8000).astype("<i2").tobytes()      # 0.1 s at 24 kHz
        frames = converter.frames(pcm)
        tail = converter.frames(b"", final=True)
        self.assertTrue(all(len(f) == audio.FRAME_BYTES for f in frames + tail))
        self.assertEqual(len(frames) + len(tail), 5)
        both = np.frombuffer(frames[1], dtype="<i2").reshape(-1, 2)
        self.assertTrue(np.array_equal(both[:, 0], both[:, 1]), "mono speech is played to both ears")
        self.assertEqual(converter.frames(b"", final=True), [])

    def test_streaming_matches_one_shot(self):
        pcm = (np.sin(np.arange(4800) * 0.03) * 9000).astype("<i2").tobytes()
        whole = audio.SpeechToDiscord(24000)
        parts = audio.SpeechToDiscord(24000)
        one = b"".join(whole.frames(pcm, final=True))
        many = b"".join(f for step in range(0, len(pcm), 1000) for f in parts.frames(pcm[step:step + 1000]))
        many += b"".join(parts.frames(b"", final=True))
        self.assertEqual(len(one), len(many))

    def test_requirements_name_what_is_missing(self):
        if importlib.util.find_spec("nacl") is None:
            self.assertIn("PyNaCl", audio.missing_requirements())
        self.assertIsInstance(audio.missing_requirements(), list)


class Bridge(unittest.IsolatedAsyncioTestCase):
    async def test_only_the_linked_person_is_heard(self):
        rig = Rig()
        await rig.begin()
        await rig.quiet(0.3)
        for index in range(60):
            rig.clock.t += 0.02
            await rig.bridge.handle(("audio", STRANGER, chunk(0.5, start=index * 960)))
            await rig.bridge.handle(("opus", STRANGER, b"OPUSxxxxxxxx"))
        await rig.quiet(1.0)
        self.assertEqual(rig.bridge.ignored, 120)
        self.assertEqual(rig.bridge.frames_in, 0, "a stranger's audio never reaches the pipeline")
        self.assertEqual(rig.codec.decoded, 0, "a stranger's Opus is never even decoded")
        self.assertEqual(rig.pipeline.transcribed, [])
        self.assertEqual(rig.sent, [])

    async def test_a_spoken_turn_is_transcribed_answered_and_encoded(self):
        rig = Rig()
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.8)
        await rig.quiet(1.2)
        self.assertEqual(len(rig.pipeline.transcribed), 1)
        self.assertEqual(rig.pipeline.spoken, ["Hello to you, friend.", "How can I help today?"])
        self.assertGreaterEqual(len(rig.sent), 8)
        self.assertTrue(all(p.startswith(b"OPUS") for p in rig.sent), "the bot's voice leaves as Opus packets")
        self.assertEqual(rig.bridge.heard, ["hello there"])
        self.assertEqual(rig.cleared, [])
        # The turn's audio reached speech-to-text at 16 kHz mono PCM16 (more than the 0.8 s spoken, with its pre-roll).
        self.assertGreater(rig.pipeline.transcribed[0], 16000 * 2 * 0.8)

    async def test_opus_packets_from_the_linked_person_are_decoded(self):
        rig = Rig()
        await rig.begin()
        await rig.quiet(0.3)
        for _ in range(10):
            rig.clock.t += 0.02
            await rig.bridge.handle(("opus", OWNER, b"OPUS" + chunk(0.4)[:8]))
        self.assertEqual(rig.codec.decoded, 10)
        self.assertEqual(rig.bridge.frames_in, 10)

    async def test_silence_alone_finishes_a_turn_because_discord_stops_sending(self):
        rig = Rig()
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.6)
        self.assertEqual(rig.pipeline.transcribed, [])
        await rig.quiet(1.0)       # no audio packets at all: the clock alone feeds the endpointer silence
        self.assertEqual(len(rig.pipeline.transcribed), 1)

    async def test_smart_turn_ends_a_complete_turn_after_a_short_pause(self):
        rig = Rig(pipeline=FakePipeline(verdict=True), smart_turn=True)
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.6)
        await rig.quiet(0.4)       # well under the 700 ms silence wait
        self.assertEqual(len(rig.pipeline.transcribed), 1)

    async def test_smart_turn_incomplete_waits_longer(self):
        rig = Rig(pipeline=FakePipeline(verdict=False), smart_turn=True)
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.6)
        await rig.quiet(1.2)       # past the ordinary wait, inside the "still thinking" cap
        self.assertEqual(rig.pipeline.transcribed, [])
        await rig.quiet(1.6)
        self.assertEqual(len(rig.pipeline.transcribed), 1)

    async def test_talking_over_the_bot_interrupts_it(self):
        rig = Rig(pipeline=FakePipeline(seconds=3.0), pace=True, sleep=never)
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.6)
        await rig.quiet(1.0)
        self.assertEqual(rig.bridge.phase, "speaking")
        self.assertEqual(len(rig.pipeline.transcribed), 1)
        before = len(rig.sent)
        await rig.talk(0.8)        # sustained speech over the reply
        self.assertEqual(rig.pipeline.interrupts[-1], True, "the model is told it was cut off mid-speech")
        self.assertEqual(rig.cleared, [1], "queued audio is dropped so it stops at once")
        self.assertEqual(rig.bridge.play_end, 0.0)
        self.assertGreaterEqual(before, 100)
        await rig.quiet(1.0)       # the interruption itself is heard as the next turn
        self.assertEqual(len(rig.pipeline.transcribed), 2)

    async def test_a_short_mm_hm_does_not_interrupt(self):
        rig = Rig(pipeline=FakePipeline(seconds=3.0), pace=True, sleep=never)
        await rig.begin()
        await rig.quiet(0.3)
        await rig.talk(0.6)
        await rig.quiet(1.0)
        self.assertEqual(rig.bridge.phase, "speaking")
        await rig.talk(0.2)        # shorter than the barge-in threshold
        await rig.quiet(1.0)
        self.assertEqual(rig.cleared, [])
        self.assertEqual(len(rig.pipeline.transcribed), 1, "a backchannel is not a turn")
        self.assertEqual(rig.pipeline.interrupts, [])
        self.assertEqual(rig.bridge.phase, "speaking")

    async def test_the_opening_is_spoken_once_the_person_is_there(self):
        rig = Rig(present=False, opening="This is Kip, an AI assistant from Kairos. How can I help?")
        await rig.begin()
        await rig.quiet(1.0)
        self.assertEqual(rig.sent, [], "nothing is said into an empty channel")
        await rig.bridge.handle(("joined", STRANGER))
        await settle()
        self.assertEqual(rig.sent, [])
        await rig.bridge.handle(("joined", OWNER))
        await settle()
        self.assertTrue(rig.sent)
        self.assertEqual(rig.pipeline.announced, ["This is Kip, an AI assistant from Kairos. How can I help?"])
        self.assertTrue(rig.pipeline.spoken[0].startswith("This is Kip, an AI assistant from Kairos."))

    async def test_it_leaves_when_the_person_leaves(self):
        rig = Rig()
        await rig.begin()
        await rig.bridge.handle(("left", STRANGER))
        self.assertIsNone(rig.bridge.ended)
        await rig.bridge.handle(("left", OWNER))
        self.assertEqual(rig.bridge.ended, "user left")

    async def test_it_leaves_when_nobody_comes(self):
        rig = Rig(present=False)
        await rig.quiet(60)
        self.assertIsNone(rig.bridge.ended)
        rig.clock.t += dv.JOIN_WAIT_SECONDS
        await rig.bridge.tick()
        self.assertEqual(rig.bridge.ended, "nobody joined")

    async def test_it_leaves_after_idle_minutes_but_not_while_talking(self):
        rig = Rig(idle_seconds=120)
        await rig.begin()
        await rig.quiet(100)
        self.assertIsNone(rig.bridge.ended)
        await rig.talk(0.6)        # activity resets the clock
        await rig.quiet(1.0)
        rig.clock.t += 100
        await rig.bridge.tick()
        self.assertIsNone(rig.bridge.ended, "100 s after the last exchange is not idle yet")
        rig.clock.t += 40
        await rig.bridge.tick()
        self.assertEqual(rig.bridge.ended, "idle")

    async def test_it_leaves_at_the_time_limit(self):
        rig = Rig(max_seconds=600)
        await rig.begin()
        rig.clock.t += 601
        await rig.bridge.tick()
        self.assertEqual(rig.bridge.ended, "time limit")

    async def test_run_loop_stops_and_closes_the_pipeline(self):
        rig = Rig()
        queue = asyncio.Queue()
        task = asyncio.create_task(rig.bridge.run(queue))
        await queue.put(("audio", OWNER, chunk()))
        await queue.put(("stop",))
        self.assertEqual(await asyncio.wait_for(task, 2), "stopped")
        self.assertTrue(rig.pipeline.closed)


class FakeTransport:
    def __init__(self, members):
        self.members_set, self.sent, self.cleared, self.disconnected, self.on_event = set(members), [], 0, False, None

    async def connect(self, on_event):
        self.on_event = on_event

    def members(self):
        return set(self.members_set)

    def send(self, packet):
        self.sent.append(packet)

    def clear(self):
        self.cleared += 1

    async def disconnect(self):
        self.disconnected = True

    def joined(self):
        self.arrivals = getattr(self, "arrivals", 0) + 1


class FakeHost:
    def __init__(self):
        self.connected, self.members, self.transport_made, self.dms, self.fail_connect = True, set(), None, [], False

    def client(self, bot_id):
        return object() if self.connected else None

    async def channel(self, client, channel_id):
        return SimpleNamespace(id=int(channel_id), name="voice-room", guild=SimpleNamespace(id=777))

    def describe(self, channel):
        return channel.name, str(channel.guild.id)

    def transport(self, client, channel, linked_user):
        self.transport_made = FakeTransport(self.members)
        if self.fail_connect:
            async def boom(on_event):
                raise RuntimeError("cannot connect")
            self.transport_made.connect = boom
        for name in ("decrypt", "receiving"):          # a test gives the connection its DAVE step or receive check
            if getattr(self, name, None) is not None:
                setattr(self.transport_made, name, getattr(self, name))
        return self.transport_made

    async def dm(self, client, user_id, text):
        if getattr(self, "fail_dm", False):
            raise RuntimeError("DMs closed")
        self.dms.append((user_id, text))

    async def user_name(self, client, user_id):
        return "David <3"

    async def mention(self, channel, text):
        self.mentions = getattr(self, "mentions", []) + [text]


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])
        self.bot = bots.create_bot("Home", "token-value-123", OWNER, "ep1")
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        self.host, self.pipeline, self.codec = FakeHost(), FakePipeline(), FakeCodec()
        self.clock = FakeClock()
        db = os.path.join(_DATA.name, f"out-{uuid.uuid4().hex}.sqlite3")

        async def factory(account, agent, bot):
            return self.pipeline
        for item in (patch.object(dv, "HOST", self.host), patch.object(dv, "PIPELINE_FACTORY", factory),
                     patch.object(dv, "CODEC_FACTORY", lambda: self.codec), patch.object(dv, "REQUIREMENTS", lambda: []),
                     patch.object(bot_outbound, "DB_FILE", db)):
            item.start()
            self.addCleanup(item.stop)
        dv._last_join.clear()
        dv._sessions.clear()
        self.addAsyncCleanup(dv.leave_all)

    def record(self):
        return bots.get_bot(self.bot["id"])

    async def join(self, **options):
        options.setdefault("clock", self.clock)
        options.setdefault("pace", False)
        return await dv.join("local", self.record(), AGENT, options.pop("reason", ""), **options)

    async def test_joining_dms_the_link_announces_itself_and_leaves_when_the_person_does(self):
        self.host.members = {OWNER}
        told = await self.join(reason="The build is done", invocation_id="i1")
        self.assertIn("#voice-room", told)
        self.assertEqual(self.host.dms, [(OWNER, f"I'm in #voice-room. Join me: https://discord.com/channels/777/{VOICE_CHANNEL}\nThe build is done")])
        await settle()
        self.assertTrue(self.pipeline.spoken)
        self.assertTrue(self.pipeline.spoken[0].startswith("This is Kip, an AI assistant from Kairos."))
        self.assertIn("The build is done", self.pipeline.announced[0])
        self.assertIsNotNone(dv.session_for(self.bot["id"]))
        dv.notify_voice_state(self.bot["id"], STRANGER, VOICE_CHANNEL, None)       # someone else leaving changes nothing
        await asyncio.sleep(0.15)
        self.assertIsNotNone(dv.session_for(self.bot["id"]))
        dv.notify_voice_state(self.bot["id"], OWNER, VOICE_CHANNEL, None)
        await asyncio.wait_for(self.wait_gone(), 2)
        self.assertTrue(self.host.transport_made.disconnected)
        self.assertTrue(self.pipeline.closed)

    async def wait_gone(self):
        while dv.session_for(self.bot["id"]) is not None:
            await asyncio.sleep(0.01)

    async def test_it_waits_silently_until_the_person_arrives_then_announces(self):
        await self.join(user_started=True)
        await asyncio.sleep(0.15)
        self.assertEqual(self.host.transport_made.sent, [], "nothing is said to an empty channel")
        self.assertTrue(self.pipeline.spoken, "the greeting is rendered while it waits, so it plays the moment they join")
        dv.notify_voice_state(self.bot["id"], STRANGER, None, VOICE_CHANNEL)
        await asyncio.sleep(0.15)
        self.assertEqual(self.host.transport_made.sent, [])
        dv.notify_voice_state(self.bot["id"], OWNER, None, VOICE_CHANNEL)
        await asyncio.sleep(0.2)
        self.assertTrue(self.pipeline.spoken[0].startswith("This is Kip, an AI assistant from Kairos."))
        self.assertIn("How can I help?", " ".join(self.pipeline.spoken))

    async def test_only_events_from_the_linked_person_reach_the_session(self):
        self.host.members = {OWNER}
        await self.join()
        await settle()
        self.host.transport_made.on_event(("audio", STRANGER, chunk(0.5)))
        self.host.transport_made.on_event(("audio", OWNER, chunk(0.5)))
        await asyncio.sleep(0.2)
        self.assertEqual(dv.session_for(self.bot["id"]).bridge.ignored, 1)
        self.assertEqual(dv.session_for(self.bot["id"]).bridge.frames_in, 1)

    async def test_nobody_comes_so_it_leaves(self):
        await self.join()
        await settle()
        self.clock.t += dv.JOIN_WAIT_SECONDS + 5
        await asyncio.wait_for(self.wait_gone(), 2)
        self.assertTrue(self.host.transport_made.disconnected)

    async def test_idle_session_leaves(self):
        self.host.members = {OWNER}
        await self.join()
        await settle()
        await asyncio.sleep(0.1)
        self.clock.t += dv.IDLE_SECONDS + 5
        await asyncio.wait_for(self.wait_gone(), 2)
        self.assertTrue(self.pipeline.closed)

    async def test_leaving_by_command_and_the_second_join_is_a_noop(self):
        self.host.members = {OWNER}
        await self.join()
        self.assertIn("Already", await self.join())
        self.assertEqual(len(self.host.dms), 1)
        self.assertTrue(await dv.leave(self.bot["id"]))
        self.assertIsNone(dv.session_for(self.bot["id"]))
        self.assertFalse(await dv.leave(self.bot["id"]))

    async def test_refusals_say_why(self):
        for field, value, text in (("voice_channel_id", None, "off"),):
            bots.set_voice_channel(self.bot["id"], value)
            with self.assertRaisesRegex(dv.VoiceRefused, text) as caught:
                await self.join()
            self.assertTrue(caught.exception.unavailable)
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        stored = bots._load()
        stored[self.bot["id"]]["allowed_user_id"] = None
        bots.write_json_atomic(bots.BOTS_FILE, stored)
        with self.assertRaisesRegex(dv.VoiceRefused, "allowed user"):
            await self.join()
        stored[self.bot["id"]]["allowed_user_id"] = OWNER
        bots.write_json_atomic(bots.BOTS_FILE, stored)
        with patch.object(dv, "REQUIREMENTS", lambda: ["PyNaCl", "libopus"]):
            with self.assertRaisesRegex(dv.VoiceRefused, "PyNaCl, libopus"):
                await self.join()
        self.host.connected = False
        with self.assertRaisesRegex(dv.VoiceRefused, "not connected"):
            await self.join()
        self.host.connected = True
        with patch.object(bots, "mine", lambda bot: False):
            with self.assertRaisesRegex(dv.VoiceRefused, "another account"):
                await self.join()
        self.assertIsNone(dv.session_for(self.bot["id"]))

    async def test_bot_started_calls_are_rate_limited_like_rings(self):
        self.host.members = {OWNER}
        for index in range(dv.CAPS["bot"]):
            dv._last_join.clear()
            await self.join(invocation_id=f"c{index}")
            await dv.leave(self.bot["id"])
        dv._last_join.clear()
        with self.assertRaisesRegex(dv.VoiceRefused, "limit") as caught:
            await self.join(invocation_id="over")
        self.assertFalse(caught.exception.unavailable, "a limit is not 'unavailable': it must not be worked around")

    async def test_a_pause_between_calls(self):
        self.host.members = {OWNER}
        await self.join(invocation_id="a")
        await dv.leave(self.bot["id"])
        with self.assertRaisesRegex(dv.VoiceRefused, "moment ago"):
            await self.join(invocation_id="b")

    async def test_a_failed_connection_leaves_nothing_behind_and_costs_nothing(self):
        self.host.fail_connect = True
        with self.assertRaises(RuntimeError):
            await self.join(invocation_id="x")
        self.assertIsNone(dv.session_for(self.bot["id"]))
        self.assertFalse(dv._joining)
        self.assertTrue(self.host.transport_made.disconnected)
        self.host.fail_connect = False
        self.host.members = {OWNER}
        dv._last_join.clear()
        for index in range(dv.CAPS["bot"]):          # the failed attempt did not use a unit
            dv._last_join.clear()
            await self.join(invocation_id=f"ok{index}")
            await dv.leave(self.bot["id"])

    async def test_a_ring_over_discord_joins_as_the_ringing_bot(self):
        self.host.members = {OWNER}
        with patch("services.agent_service.agent_service.get", lambda ident: AGENT if ident == "bot-kip" else None):
            told = await dv.call_user("local", "bot-kip", "  Deploy\n is done ", "inv-1")
            self.assertIn("#voice-room", told)
            self.assertIn("Deploy is done", self.host.dms[0][1])
            await dv.leave(self.bot["id"])
            with self.assertRaisesRegex(dv.VoiceRefused, "not one of yours"):
                await dv.call_user("local", "bot-other", "x", "inv-2")

    async def test_a_bot_call_is_worded_like_a_call_waits_and_greets_them_by_name(self):
        """2026-11-10: "<Bot> is calling you, tap to join", a mention, then a greeting by name the moment they join."""
        with patch("services.agent_service.agent_service.get", lambda ident: AGENT if ident == "bot-kip" else None):
            task = asyncio.create_task(dv.call_user("local", "bot-kip", "The deploy is done", "inv-ring"))
            for _ in range(50):
                if self.host.dms:
                    break
                await asyncio.sleep(0.01)
            link = f"https://discord.com/channels/777/{VOICE_CHANNEL}"
            self.assertEqual(self.host.dms, [(OWNER, f"<@{OWNER}> **Kip is calling you.** Tap to join: {link}\nThe deploy is done")])
            self.assertFalse(task.done(), "it waits for them, like a ring")
            self.assertEqual(self.host.transport_made.sent, [], "nothing is said to an empty channel")
            dv.notify_voice_state(self.bot["id"], OWNER, None, VOICE_CHANNEL)
            told = await asyncio.wait_for(task, 2)
            self.assertIn("They joined #voice-room", told)
            await asyncio.sleep(0.2)
            self.assertTrue(self.pipeline.announced[0].startswith("Hi David 3. This is Kip, an AI assistant from Kairos."),
                            self.pipeline.announced)
            self.assertIn("The deploy is done", self.pipeline.announced[0])

    async def test_nobody_joining_a_bot_call_leaves_and_says_missed(self):
        with patch("services.agent_service.agent_service.get", lambda ident: AGENT), patch.object(dv, "RING_WAIT_SECONDS", 0.3):
            with self.assertRaises(dv.VoiceRefused) as caught:
                await dv.call_user("local", "bot-kip", "Ping", "inv-missed")
        self.assertTrue(caught.exception.missed)
        self.assertFalse(caught.exception.unavailable)
        self.assertIsNone(dv.session_for(self.bot["id"]), "it left the channel")
        self.assertTrue(self.host.transport_made.disconnected)

    async def test_no_dm_means_a_mention_in_the_voice_channel_chat(self):
        self.host.members, self.host.fail_dm = {OWNER}, True
        with patch("services.agent_service.agent_service.get", lambda ident: AGENT):
            told = await dv.call_user("local", "bot-kip", "Ping", "inv-mention")
        self.assertIn("They joined", told)
        self.assertEqual(len(self.host.mentions), 1)
        self.assertTrue(self.host.mentions[0].startswith(f"<@{OWNER}> **Kip is calling you.**"))

    async def test_a_person_asked_call_keeps_its_plain_wording(self):
        self.host.members = {OWNER}
        await self.join(user_started=True)
        self.assertTrue(self.host.dms[0][1].startswith("I'm in #voice-room. Join me:"))

    async def test_text_typed_during_the_call_is_answered_in_it(self):
        self.host.members = {OWNER}
        await self.join()
        await asyncio.sleep(0.3)
        heard = []
        session = dv.session_for(self.bot["id"])

        async def respond(samples, during=False, text=None, measure=True):
            heard.append(text)
        session.bridge._respond = respond
        self.assertTrue(dv.typed_into_call(self.bot["id"], "  is the build green?  "))
        await asyncio.sleep(0.2)
        self.assertEqual(heard, ["(typed) is the build green?"])
        self.assertFalse(dv.typed_into_call("another-bot", "hi"))

    async def test_no_bot_with_voice_means_unavailable(self):
        bots.set_voice_channel(self.bot["id"], None)
        with patch("services.agent_service.agent_service.get", lambda ident: AGENT):
            with self.assertRaises(dv.VoiceRefused) as caught:
                await dv.call_user("local", "bot-kip", "x", "inv-3")
        self.assertTrue(caught.exception.unavailable)

    async def test_call_me_uses_the_front_desk_bot_and_replies_only_on_failure(self):
        self.host.members = {OWNER}
        with patch("services.front_desk.bot_id", lambda: "bot-kip"), \
                patch("services.agent_service.agent_service.get", lambda ident: AGENT):
            self.assertIsNone(await dv.handle_call_request("local", self.record()))
            self.assertEqual(len(self.host.dms), 1)
            await dv.leave(self.bot["id"])
            self.assertIn("moment ago", await dv.handle_call_request("local", self.record()))
        with patch("services.front_desk.bot_id", lambda: None):
            self.assertIn("No bot", await dv.handle_call_request("local", self.record()))


class RingRouting(unittest.IsolatedAsyncioTestCase):
    """ring_me and notify_me_by_call follow the call order in Settings > Reach me (services/reach_me.py)."""

    def setUp(self):
        from core import reach_me as reach_settings
        from services import reach_me as reach_service
        self.ctx = SimpleNamespace(invocation_id="inv-9")
        self.calls = []
        self.order = ["phone", "app", "discord", "telegram"]
        self.phone_ready = False

        async def ring_user(account, bot_id, reason, ident, **_how):
            self.calls.append(("ring", reason))
            return "rang"

        async def phone_call(account, bot_id, message, ident):
            self.calls.append(("phone", message))
            return "phoned"
        self.discord = AsyncMock(side_effect=lambda account, bot_id, reason, ident: self.calls.append(("discord", reason)) or "joined")
        for item in (patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}),
                     patch.object(reach_service, "_bot", lambda account, bot_id, strict=True: dict(AGENT)),
                     patch.object(reach_service, "_phone_ready", lambda account: self.phone_ready),
                     patch.object(reach_settings, "order_for", lambda bot_id, kind, account=None: list(self.order)),
                     patch.object(reach_settings, "quiet_until", lambda account=None, now=None: None),
                     patch.object(phone_tools.rings, "ring_user", ring_user),
                     patch.object(phone_tools.phone_calls, "call_user", phone_call),
                     patch.object(dv, "call_user", self.discord),
                     patch.object(dv, "pick_bot", lambda account: {"id": "discord-bot"})):
            item.start()
            self.addCleanup(item.stop)

    async def test_the_default_order_phones_when_a_phone_is_set_up_and_rings_in_the_app_otherwise(self):
        self.assertEqual(await phone_tools.tool_ring({"reason": "r"}, self.ctx), "rang")
        self.assertEqual(await phone_tools.tool_call({"message": "m"}, self.ctx), "rang")
        self.phone_ready = True
        self.assertEqual(await phone_tools.tool_call({"message": "m"}, self.ctx), "phoned")
        self.assertEqual(await phone_tools.tool_ring({"reason": "r"}, self.ctx), "phoned")
        self.assertNotIn("discord", [c[0] for c in self.calls])

    async def test_discord_first_joins_the_voice_channel(self):
        self.order = ["discord", "phone", "app"]
        self.assertEqual(await phone_tools.tool_ring({"reason": "r"}, self.ctx), "joined")
        self.phone_ready = True
        self.assertEqual(await phone_tools.tool_call({"message": "m"}, self.ctx), "joined")
        self.assertEqual([c[0] for c in self.calls], ["discord", "discord"])

    async def test_discord_not_available_falls_back_to_the_next_way(self):
        self.order = ["discord", "phone", "app"]
        self.discord.side_effect = dv.VoiceRefused("not set up", unavailable=True)
        self.assertEqual(await phone_tools.tool_ring({"reason": "r"}, self.ctx), "rang")
        self.phone_ready = True
        self.assertEqual(await phone_tools.tool_call({"message": "m"}, self.ctx), "phoned")

    async def test_nobody_joining_discord_falls_to_the_next_way(self):
        self.order = ["discord", "app"]
        self.discord.side_effect = dv.VoiceRefused("Nobody joined #voice-room within a minute.", missed=True)
        self.assertEqual(await phone_tools.tool_ring({"reason": "r"}, self.ctx), "rang")
        self.assertEqual([c[0] for c in self.calls], ["ring"])

    async def test_every_way_missed_tells_the_bot_they_did_not_answer(self):
        from services import rings
        self.order = ["discord", "app"]
        self.discord.side_effect = dv.VoiceRefused("Nobody joined.", missed=True)

        async def missed(*args, **kwargs):
            raise rings.RingUnanswered("Nobody answered the ring.")
        with patch.object(phone_tools.rings, "ring_user", missed):
            result = await phone_tools.tool_ring({"reason": "r"}, self.ctx)
        self.assertTrue(result.startswith("They did not answer (Discord voice channel, Ring in the Kairos app)"), result)
        self.assertIn("Do not call again", result)

    async def test_a_discord_limit_is_reported_not_worked_around(self):
        self.order = ["discord", "phone", "app"]
        self.discord.side_effect = dv.VoiceRefused("Today's limit is used up.")
        self.phone_ready = True
        for result in (await phone_tools.tool_ring({"reason": "r"}, self.ctx), await phone_tools.tool_call({"message": "m"}, self.ctx)):
            self.assertEqual(result, "Not sent: Today's limit is used up.")
        self.assertEqual(self.calls, [])

    async def test_the_old_ring_preference_seeds_the_call_order(self):
        from core import reach_me as reach_settings
        try:
            settings_store.update_settings(ring_preference="discord")
            self.assertEqual(reach_settings._legacy_call_order(None)[0], "discord")
            settings_store.update_settings(ring_preference="app")
            self.assertEqual(reach_settings._legacy_call_order(None), reach_settings.DEFAULT_CALL)
        finally:
            settings_store.update_settings(ring_preference="app")

    def test_the_preference_is_a_setting_that_defaults_to_the_app(self):
        self.assertEqual(settings_store.DEFAULTS["ring_preference"], "app")
        self.assertIn("ring_preference", settings_store.ACCOUNT_KEYS)


class FakeDiscord:
    class Intents:
        message_content = False

        @classmethod
        def default(cls):
            return cls()

    class File:
        def __init__(self, path):
            self.path = path

    class Client:
        def __init__(self, intents=None):
            self.handlers, self.user = {}, object()

        def event(self, fn):
            self.handlers[fn.__name__] = fn
            return fn


class Channel:
    def __init__(self, ident):
        self.id, self.sent = int(ident), []

    async def send(self, text=None, file=None):
        self.sent.append(text if file is None else file)

    def typing(self):
        outer = self

        class Context:
            async def __aenter__(self_inner): return outer
            async def __aexit__(self_inner, *a): return False
        return Context()


def message(channel, author, text):
    return SimpleNamespace(author=SimpleNamespace(id=int(author)), channel=Channel(channel), content=text, attachments=[],
                           reference=None, id=1, created_at=SimpleNamespace(isoformat=lambda: "2026-11-06T00:00:00"), jump_url="u")


class DiscordSide(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])
        self.bot = bots.create_bot("Home", "token-value-123", OWNER, None)
        bots.add_channel(self.bot["id"], "444", "open-room", "open")
        self.turn = AsyncMock(return_value="bot reply")
        self.handle = AsyncMock(return_value=None)
        for item in (patch("services.chat_service.send_message", self.turn), patch("core.tab_hooks.emit_message"),
                     patch("core.session_manager.SessionManager.get_or_create_channel_session", return_value="sid"),
                     patch.object(dv, "handle_call_request", self.handle)):
            item.start()
            self.addCleanup(item.stop)
        self.client = dc._build_client(FakeDiscord, bots.get_bot(self.bot["id"]))

    async def say(self, channel, author, text):
        m = message(channel, author, text)
        await self.client.handlers["on_message"](m)
        return m.channel.sent

    def test_the_call_phrases(self):
        for text in ("call me", "Call me!", "/kairos call", "kairos call", "!call", "ring me", "join me in voice", "hop on a call", "call me please"):
            self.assertTrue(dv.is_call_request(text), text)
        for text in ("call me when the build is done", "can you call me", "call", "who should I call", "", None, "call mom"):
            self.assertFalse(dv.is_call_request(text), text)

    async def test_off_by_default_so_call_me_is_just_a_message(self):
        self.assertEqual(bots.get_bot(self.bot["id"]).get("voice_channel_id"), None)
        self.assertEqual(await self.say("333", OWNER, "call me"), ["bot reply"])
        self.handle.assert_not_called()

    async def test_the_allowed_user_asking_to_be_called_starts_a_voice_call(self):
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        self.assertEqual(await self.say("333", OWNER, "/kairos call"), [])
        self.handle.assert_awaited_once()
        self.assertEqual(self.handle.await_args.args[1]["id"], self.bot["id"])
        self.assertFalse(self.turn.called, "the request is not also sent to the model")

    async def test_a_refusal_is_said_back(self):
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        self.handle.return_value = "The Discord bot is not connected right now."
        self.assertEqual(await self.say("333", OWNER, "call me"), ["The Discord bot is not connected right now."])

    async def test_strangers_and_open_channels_cannot_start_a_call(self):
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        self.assertEqual(await self.say("333", STRANGER, "call me"), [])
        self.assertEqual(await self.say("444", OWNER, "call me"), ["bot reply"], "an open channel never starts calls")
        self.assertEqual(await self.say("444", STRANGER, "call me"), ["bot reply"])
        self.handle.assert_not_called()

    async def test_other_messages_are_unaffected(self):
        bots.set_voice_channel(self.bot["id"], VOICE_CHANNEL)
        self.assertEqual(await self.say("333", OWNER, "call me when it's done"), ["bot reply"])
        self.handle.assert_not_called()

    async def test_voice_state_changes_are_forwarded(self):
        seen = []
        with patch.object(dv, "notify_voice_state", lambda *a: seen.append(a)):
            await self.client.handlers["on_voice_state_update"](
                SimpleNamespace(id=int(OWNER)), SimpleNamespace(channel=None), SimpleNamespace(channel=SimpleNamespace(id=int(VOICE_CHANNEL))))
        self.assertEqual(seen, [(self.bot["id"], OWNER, None, int(VOICE_CHANNEL))])


class Settings(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])
        self.bot = bots.create_bot("Home", "token-value-123", OWNER, None)

    def test_voice_is_off_by_default_and_the_id_is_validated(self):
        self.assertIsNone(self.bot["voice_channel_id"])
        self.assertEqual(bots.set_voice_channel(self.bot["id"], " 123 ")["voice_channel_id"], "123")
        with self.assertRaises(ValueError):
            bots.set_voice_channel(self.bot["id"], "general")
        with self.assertRaises(KeyError):
            bots.set_voice_channel("nope", "1")
        self.assertEqual(bots.update_bot(self.bot["id"], name="Renamed")["voice_channel_id"], "123", "editing the bot keeps it")
        self.assertIsNone(bots.set_voice_channel(self.bot["id"], "")["voice_channel_id"])

    async def test_routes(self):
        from routes import settings_routes as routes
        saved = await routes.set_discord_voice(self.bot["id"], routes.SetDiscordVoiceRequest(voice_channel_id="777"), user="u")
        self.assertEqual(saved["voice_channel_id"], "777")
        with self.assertRaises(HTTPException) as caught:
            await routes.set_discord_voice(self.bot["id"], routes.SetDiscordVoiceRequest(voice_channel_id="x"), user="u")
        self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(HTTPException) as caught:
            await routes.set_discord_voice("nope", routes.SetDiscordVoiceRequest(voice_channel_id="1"), user="u")
        self.assertEqual(caught.exception.status_code, 404)
        left = []

        async def leave(bot_id):
            left.append(bot_id)
        with patch.object(dv, "leave", leave):
            await routes.set_discord_voice(self.bot["id"], routes.SetDiscordVoiceRequest(voice_channel_id=""), user="u")
        self.assertEqual(left, [self.bot["id"]], "turning voice off ends a call in progress")
        self.assertEqual((await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="discord"), user="u"))["ring_preference"], "discord")
        self.assertEqual(settings_store.get_setting("ring_preference"), "discord")
        self.assertEqual((await routes.get_settings(user="u"))["ring_preference"], "discord")
        with self.assertRaises(HTTPException):
            await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="carrier pigeon"), user="u")
        await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="app"), user="u")


class RealTransportFilter(unittest.IsolatedAsyncioTestCase):
    async def test_only_the_linked_users_audio_leaves_the_receiving_thread(self):
        events = []
        transport = discord_voice_transport.RealTransport(SimpleNamespace(members=[SimpleNamespace(id=1), SimpleNamespace(id=2)]),
                                                          "1", asyncio.get_running_loop())
        transport.on_event = events.append
        transport._on_voice(SimpleNamespace(id=2), SimpleNamespace(pcm=b"\x01\x00" * 4))
        transport._on_voice(None, SimpleNamespace(pcm=b"\x01\x00" * 4))
        transport._on_voice(SimpleNamespace(id=1), SimpleNamespace(pcm=None))
        transport._on_voice(SimpleNamespace(id=1), SimpleNamespace(pcm=b"\x02\x00" * 4))
        self.assertEqual(events, [("audio", "1", b"\x02\x00" * 4)])
        self.assertEqual(transport.members(), {"1", "2"})
        transport.send(b"a")
        transport.send(b"b")
        transport.clear()
        self.assertEqual(len(transport._queue), 0)


# -- receiving (David's test, 2026-11-11: Kip joined, the first DAVE-encrypted frame failed Opus, receiving died) --------

def dave_wrapped(opus: bytes, tag=b"\x08" * 8) -> bytes:
    """A frame as DAVE sends it: ciphertext (here the Opus itself), an 8-byte tag, a 1-byte nonce, no unencrypted
    ranges, the supplemental size, the 0xFAFA marker."""
    supplemental = tag + b"\x05" + bytes([len(tag) + 1 + 1 + 2])
    return opus + supplemental + audio.DAVE_MAGIC


def corrupt_dave_frame() -> bytes:
    """What libopus was handed in David's test: a DAVE frame read as Opus. TOC code 1 (two equal frames) with an odd
    length is invalid Opus, so the real decoder says "corrupted stream", as in the log."""
    frame = dave_wrapped(b"\x01" + b"\x10" * 258)
    return frame if (len(frame) - 1) % 2 else dave_wrapped(b"\x01" + b"\x10" * 259)


def opus_of(index, amp=0.4) -> bytes:
    """A fake Opus packet carrying 20 ms of a tone (the codec below decodes it back to that PCM)."""
    return b"OPUS" + chunk(amp, start=index * audio.FRAME_SAMPLES)


class BreakableCodec(FakeCodec):
    """Opus stand-in whose decoder returns the whole PCM a packet carries, and fails like libopus on b'BAD...'."""
    def __init__(self):
        super().__init__()
        self.decoders = 0

    def new_decoder(self):
        self.decoders += 1

        class Decoder:
            def decode(self, packet):
                if packet.startswith(b"BAD"):
                    raise RuntimeError("corrupted stream")
                return packet[4:]
        return Decoder()


class Receiving(unittest.IsolatedAsyncioTestCase):
    def rig(self, **options):
        rig = Rig(**options)
        rig.codec = rig.bridge.codec = BreakableCodec()
        return rig

    async def test_a_corrupted_frame_mid_call_is_dropped_and_the_turn_is_still_heard(self):
        rig = self.rig()
        await rig.begin()
        await rig.quiet(0.3)
        for index in range(40):                          # 0.8 s of talking with one broken frame in the middle
            rig.clock.t += 0.02
            await rig.bridge.handle(("opus", OWNER, b"BAD frame" if index == 20 else opus_of(index)))
        await settle()
        self.assertEqual((rig.bridge.decoded, rig.bridge.bad_packets), (39, 1))
        self.assertEqual(rig.codec.decoders, 2, "the person's decoder is reset after a bad frame")
        await rig.quiet(1.2)
        self.assertEqual(len(rig.pipeline.transcribed), 1, "receiving carried on: the turn was heard and answered")
        self.assertTrue(rig.sent)
        self.assertIsNone(rig.bridge.cant_hear)
        self.assertIsNone(rig.bridge.ended)

    async def test_dave_frames_are_opened_before_they_are_decoded(self):
        opened = []

        def unwrap(user, frame):
            opened.append(user)
            self.assertTrue(audio.is_dave_frame(frame))
            return frame[:-12]
        rig = self.rig(unwrap=unwrap)
        await rig.begin()
        for index in range(10):
            rig.clock.t += 0.02
            await rig.bridge.handle(("opus", OWNER, dave_wrapped(opus_of(index))))
        self.assertEqual(rig.bridge.decoded, 10)
        self.assertEqual(rig.bridge.bad_packets, 0)
        self.assertEqual(opened, [OWNER] * 10)

    async def test_a_second_of_frames_it_cannot_open_says_so_and_leaves(self):
        def unwrap(user, frame):
            raise audio.Undecryptable("no DAVE session")
        rig = self.rig(unwrap=unwrap)
        await rig.begin()
        for index in range(dv.CANT_HEAR_PACKETS - 1):
            rig.clock.t += 0.02
            await rig.bridge.handle(("opus", OWNER, dave_wrapped(opus_of(index))))
        self.assertIsNone(rig.bridge.cant_hear, "a few bad frames are only dropped")
        rig.clock.t += 0.02
        await rig.bridge.handle(("opus", OWNER, dave_wrapped(opus_of(0))))
        await settle()
        self.assertIsNotNone(rig.bridge.cant_hear)
        self.assertEqual(rig.pipeline.spoken, [dv.CANT_HEAR_LINE])
        self.assertTrue(rig.sent, "it says it out loud rather than sitting silent")
        self.assertEqual(rig.bridge.ended, "cannot hear")

    async def test_a_good_frame_between_bad_ones_resets_the_count(self):
        rig = self.rig()
        await rig.begin()
        for index in range(dv.CANT_HEAR_PACKETS * 2):
            rig.clock.t += 0.02
            await rig.bridge.handle(("opus", OWNER, opus_of(index) if index % 10 == 0 else b"BAD"))
        self.assertIsNone(rig.bridge.cant_hear)

    async def test_receiving_that_stopped_and_will_not_restart_says_so(self):
        alive = [True]
        rig = self.rig(receiving=lambda: alive[0])
        await rig.begin()
        await rig.quiet(2.0)
        self.assertIsNone(rig.bridge.ended)
        alive[0] = False
        await rig.quiet(1.5)
        self.assertEqual(rig.bridge.ended, "cannot hear")
        self.assertIn("receiving stopped", rig.bridge.cant_hear)
        self.assertEqual(rig.pipeline.spoken, [dv.CANT_HEAR_LINE])

    async def test_the_cannot_hear_line_waits_for_the_greeting(self):
        rig = self.rig(opening="This is Kip, an AI assistant from Kairos. How can I help?", receiving=lambda: False)
        await rig.begin()
        await rig.quiet(1.5)
        self.assertEqual(rig.pipeline.spoken[:2], ["This is Kip, an AI assistant from Kairos.", "How can I help?"])
        self.assertEqual(rig.pipeline.spoken[-1], dv.CANT_HEAR_LINE)
        self.assertEqual(rig.bridge.ended, "cannot hear")

    def test_the_real_extension_no_longer_decodes_or_dies(self):
        """Against the installed discord-ext-voice-recv (skipped without it): the DAVE frame that raises "corrupted
        stream" with a decoding sink (David's log) passes through untouched with decode=False."""
        if importlib.util.find_spec("discord.ext.voice_recv") is None or not audio._opus_loadable():
            self.skipTest("discord-ext-voice-recv or libopus is not installed")
        import struct
        from discord.ext.voice_recv import opus as recv_opus, rtp, sinks, utils
        frame = corrupt_dave_frame()
        self.assertTrue(audio.is_dave_frame(frame))
        outcomes = {}
        for decode in (True, False):
            sink = sinks.BasicSink(lambda user, data: None, decode=decode)
            sink._voice_client = SimpleNamespace(_get_id_from_ssrc=lambda ssrc: None)
            decoder = recv_opus.PacketDecoder(SimpleNamespace(sink=sink, waiter=utils.MultiDataEvent()), 1486)
            packet = rtp.decode_rtp(bytes([0x80, 0x78]) + struct.pack(">HII", 1, 960, 1486) + b"\x00" * 20)
            packet.decrypted_data = frame
            decoder.push_packet(packet)
            try:
                outcomes[decode] = decoder.pop_data().opus
            except Exception as error:
                outcomes[decode] = str(error)
        self.assertEqual(outcomes[True], "corrupted stream", "the failure in David's log, reproduced")
        self.assertEqual(outcomes[False], frame, "with decode=False the frame reaches the session as it came")


class FakeDave:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def decrypt(self, user_id, media_type, frame):
        self.calls.append((user_id, media_type, frame))
        if self.fail:
            raise RuntimeError("missing key")
        return frame[:-12]


class RealTransportReceive(unittest.IsolatedAsyncioTestCase):
    def transport(self, mapping=None, session=None, version=1):
        transport = discord_voice_transport.RealTransport(SimpleNamespace(members=[]), OWNER, asyncio.get_running_loop())
        mapping = mapping if mapping is not None else {}
        transport.vc = SimpleNamespace(_get_id_from_ssrc=mapping.get,
                                       _connection=SimpleNamespace(dave_session=session, dave_protocol_version=version))
        self.events = []
        transport.on_event = self.events.append
        return transport, mapping

    async def test_an_unknown_stream_is_dropped_until_discord_says_it_is_theirs(self):
        transport, mapping = self.transport()
        frame = SimpleNamespace(opus=b"opus-1", packet=SimpleNamespace(ssrc=1486))
        transport._on_voice(None, frame)                          # before Discord said whose stream 1486 is
        self.assertEqual(self.events, [], "unknown audio is dropped, never held")
        mapping[1486] = int(STRANGER)
        transport._on_voice(None, frame)
        self.assertEqual(self.events, [], "someone else's stream is dropped")
        mapping[1486] = int(OWNER)
        transport._on_voice(None, frame)                          # mapped, but no cached member: found by its stream
        transport._on_voice(SimpleNamespace(id=int(OWNER)), SimpleNamespace(opus=b"opus-2", packet=None))
        transport._on_voice(SimpleNamespace(id=int(OWNER)), SimpleNamespace(opus=b"", packet=None))   # a lost packet
        self.assertEqual(self.events, [("opus", OWNER, b"opus-1"), ("opus", OWNER, b"opus-2")])

    async def test_nothing_escapes_into_the_extensions_thread(self):
        transport, _ = self.transport()

        def boom(event):
            raise RuntimeError("queue closed")
        transport.on_event = boom
        transport._on_voice(SimpleNamespace(id=int(OWNER)), SimpleNamespace(opus=b"x", packet=None))
        transport._on_voice(SimpleNamespace(id=int(OWNER)), SimpleNamespace(opus=b"y", packet=None))
        self.assertEqual(transport.sink_errors, 2)

    async def test_dave_frames_are_opened_with_discord_pys_session(self):
        if importlib.util.find_spec("davey") is None:
            self.skipTest("davey is not installed")
        import davey
        dave = FakeDave()
        transport, _ = self.transport(session=dave)
        wrapped = dave_wrapped(b"opus-payload")
        self.assertEqual(transport.decrypt(OWNER, wrapped), b"opus-payload")
        self.assertEqual(dave.calls, [(int(OWNER), davey.MediaType.audio, wrapped)])
        self.assertEqual(transport.decrypt(OWNER, audio.OPUS_SILENCE), audio.OPUS_SILENCE, "silence is never encrypted")

    async def test_a_plain_frame_passes_and_an_encrypted_one_it_cannot_open_is_refused(self):
        transport, _ = self.transport(session=FakeDave(fail=True))
        self.assertEqual(transport.decrypt(OWNER, b"\x78plain-opus"), b"\x78plain-opus", "passthrough while keys change")
        with self.assertRaises(audio.Undecryptable):
            transport.decrypt(OWNER, dave_wrapped(b"opus"))
        transport, _ = self.transport(session=None, version=0)
        self.assertEqual(transport.decrypt(OWNER, b"\x78plain-opus"), b"\x78plain-opus", "a channel without DAVE")
        with self.assertRaisesRegex(audio.Undecryptable, "no DAVE session"):
            transport.decrypt(OWNER, dave_wrapped(b"opus"))

    async def test_receiving_is_restarted_a_few_times_then_reported(self):
        transport, _ = self.transport()
        listening = [False]
        listens = []
        transport.vc.is_listening = lambda: listening[0]
        transport.vc.is_connected = lambda: True
        transport.vc.listen = lambda sink: listens.append(sink) or listening.__setitem__(0, True)
        transport.SINK = lambda callback: ("sink", callback)
        self.assertTrue(transport.receiving())
        self.assertEqual(listens, [("sink", transport._on_voice)])
        transport.vc.listen = lambda sink: listens.append(sink)       # restarting no longer helps
        listening[0] = False
        self.assertFalse(transport.receiving())
        self.assertFalse(transport.receiving())
        self.assertEqual(len(listens), discord_voice_transport.RESTARTS)
        self.assertFalse(transport.receiving(), "it gives up after RESTARTS")
        self.assertEqual(len(listens), discord_voice_transport.RESTARTS)

    def test_dave_frames_are_recognised(self):
        self.assertTrue(audio.is_dave_frame(dave_wrapped(b"\x78" * 40)))
        self.assertFalse(audio.is_dave_frame(b"\x78" * 40))
        self.assertFalse(audio.is_dave_frame(audio.OPUS_SILENCE))
        self.assertFalse(audio.is_dave_frame(b""))
        self.assertFalse(audio.is_dave_frame(b"\x78" * 12 + b"\x02\xfa\xfa"), "a size too small to be DAVE's")


class LifecycleReceiving(Lifecycle):
    """Lifecycle's setUp, these tests only (Lifecycle's own run once, in Lifecycle)."""

    async def test_greeting_is_ready_before_they_join_and_plays_at_once(self):
        slow = self.pipeline
        real_speak = slow.speak

        async def speak(text):                     # a voice that takes a while to load, like Kokoro on first use
            await asyncio.sleep(0.3)
            async for item in real_speak(text):
                yield item
        slow.speak = speak
        await self.join(user_started=True)
        await asyncio.sleep(0.9)                   # waiting for them: the greeting renders now
        self.assertEqual(self.host.transport_made.sent, [])
        dv.notify_voice_state(self.bot["id"], OWNER, None, VOICE_CHANNEL)
        await asyncio.sleep(0.1)                   # far less than one sentence's render
        self.assertTrue(self.host.transport_made.sent, "the greeting plays the moment they join")
        self.assertEqual(getattr(self.host.transport_made, "arrivals", 0), 1, "the connection hears that they arrived")

    async def test_not_hearing_them_is_said_then_they_get_a_dm(self):
        def decrypt(user, frame):
            raise audio.Undecryptable("no DAVE session")
        self.host.decrypt = decrypt
        self.host.members = {OWNER}
        await self.join(user_started=True)
        await asyncio.sleep(0.1)
        for _ in range(dv.CANT_HEAR_PACKETS):
            self.host.transport_made.on_event(("opus", OWNER, dave_wrapped(b"OPUS" + b"\x00" * 8)))
        await asyncio.wait_for(self.wait_gone(), 3)
        self.assertIn(dv.CANT_HEAR_LINE, self.pipeline.spoken)
        self.assertEqual(self.host.dms[-1], (OWNER, dv.CANT_HEAR_DM.format(channel="voice-room")))
        self.assertTrue(self.host.transport_made.disconnected)
        self.assertTrue(self.pipeline.closed)


for _name in [name for name in vars(Lifecycle) if name.startswith("test_")]:
    setattr(LifecycleReceiving, _name, None)       # Lifecycle's own tests run once, in Lifecycle


if __name__ == "__main__":
    unittest.main(verbosity=1)
