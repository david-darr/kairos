"""Phone calls and texts through the person's own Twilio or Telnyx number (build spec step 8), with fakes only:
no network, no provider account, no real call or text. Run: python scripts/test_phone_calls.py
"""
import asyncio
import base64
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qsl, urlencode

_DATA = tempfile.TemporaryDirectory(prefix="kairos-phone-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from cryptography.fernet import InvalidToken  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from core import accounts, bot_outbound, phone_audio, phone_connection as connection, phone_providers as providers  # noqa: E402
from core import secret_storage  # noqa: E402
from services import phone_bridge, phone_calls, phone_tools  # noqa: E402

BASE = "https://kairos.example.net"
NUMBER_1, MOBILE_1 = "+15550001111", "+15557770001"
NUMBER_2, MOBILE_2 = "+15550002222", "+15557770002"
STRANGER = "+15559998888"
TOKEN_1, TOKEN_2 = "twilio-token-one", "twilio-token-two"
BOT = {"id": "bot-kip", "name": "Kip", "voice_id": None}


def tone(ms, amplitude=0.3, freq=300):
    count = 8 * ms
    return (amplitude * np.sin(2 * np.pi * freq * np.arange(count) / 8000)).astype(np.float32)


def frames_of(samples):
    data = phone_audio.mulaw_encode(samples)
    return [data[i:i + 160] for i in range(0, len(data) - 159, 160)]


def silence(ms):
    return [b"\xff" * 160 for _ in range(ms // 20)]


def twilio_media(frame):
    return json.dumps({"event": "media", "media": {"track": "inbound", "payload": base64.b64encode(frame).decode()}})


def twilio_start(token, stream="MZ1"):
    return json.dumps({"event": "start", "start": {"streamSid": stream, "callSid": "CA1", "customParameters": {"t": token}}})


def sign_twilio(token, url, params):
    return providers.twilio_signature(token, url, params)


class Settled:
    @staticmethod
    async def until(predicate, timeout=4.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return True
            await asyncio.sleep(0.01)
        return predicate()


class FakeProviderAPI:
    """Stands in for api.twilio.com / api.telnyx.com: records every request, answers like the real ones would."""

    def __init__(self):
        self.requests = []
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        self.requests.append({"method": request.method, "url": str(request.url), "body": body, "headers": dict(request.headers)})
        url = str(request.url)
        if url.endswith("Calls.json"):
            return httpx.Response(201, json={"sid": "CAfake"})
        if url.endswith("Messages.json"):
            return httpx.Response(201, json={"sid": "SMfake"})
        if url.endswith("/v2/calls"):
            return httpx.Response(200, json={"data": {"call_control_id": "ccid-fake"}})
        if url.endswith("/v2/messages"):
            return httpx.Response(200, json={"data": {"id": "msg-fake"}})
        return httpx.Response(200, json={"data": {"result": "ok"}})

    def form(self, index=-1):
        return dict(parse_qsl(self.requests[index]["body"]))

    def json(self, index=-1):
        return json.loads(self.requests[index]["body"])


class FakePipeline(phone_bridge.Pipeline):
    def __init__(self):
        self.heard, self.interrupts, self.announced, self.spoken, self.asked = [], [], [], [], []
        self.reply = ["Sure thing. ", "I can do that for you."]
        self.gate = None
        self.verdict = None
        self.touched, self.closed = 0, False

    async def transcribe(self, pcm16):
        self.heard.append(pcm16)
        return "hello there"

    async def end_of_turn(self, pcm16):
        self.asked.append(len(pcm16))
        return self.verdict

    async def converse(self, text, request_id):
        for part in self.reply:
            yield part

    async def announce(self, text, request_id):
        self.announced.append(text)

    async def speak(self, text):
        self.spoken.append(text)
        pcm = phone_audio.float_to_pcm16(0.3 * np.sin(2 * np.pi * 220 * np.arange(9600) / 24000))   # 0.4 s at 24 kHz
        yield 24000, pcm[:4800]
        if self.gate is not None:
            await self.gate.wait()
        yield 24000, pcm[4800:]

    def interrupt(self, spoken):
        self.interrupts.append(spoken)

    def touch(self):
        self.touched += 1

    async def close(self):
        self.closed = True


class FakeSocket:
    def __init__(self, messages=(), headers=None, query=None, stop_when=None):
        self.queue = asyncio.Queue()
        for message in messages:
            self.queue.put_nowait(message)
        self.headers, self.query = headers or {}, query or {}
        self.sent, self.closed, self.stop_when = [], None, stop_when

    async def recv(self):
        """The queued messages, then (when stop_when is given) quiet until that is true and then the end of the call."""
        if self.queue.empty() and self.stop_when is not None:
            end = time.monotonic() + 4
            while not self.stop_when() and time.monotonic() < end:
                await asyncio.sleep(0.01)
            return None
        return await self.queue.get()

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = code

    def media_sent(self):
        return [m for m in self.sent if m.get("event") == "media"]


def setup_accounts():
    values = {"provider": "twilio", "account_sid": "ACone", "auth_token": TOKEN_1, "number": NUMBER_1,
              "user_number": MOBILE_1, "public_url": BASE, "conversation_endpoint_id": "fast", "conversation_model": "small",
              "require_pin": False}          # the PIN has its own tests below
    connection.save(values, account="acct1")
    connection.save({**values, "account_sid": "ACtwo", "auth_token": TOKEN_2, "number": NUMBER_2, "user_number": MOBILE_2}, account="acct2")


class PhoneTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = []
        for patcher in (patch.object(connection, "accounts_to_scan", lambda: ["acct1", "acct2"]),
                        patch.object(phone_calls, "bot_for", lambda account, record: dict(BOT)),
                        patch.object(bot_outbound, "DB_FILE", os.path.join(_DATA.name, f"out-{uuid.uuid4().hex}.sqlite3"))):
            patcher.start()
            self.stack.append(patcher)
        bot_outbound.reset_for_test()

        async def no_problem(account, record, bot):
            return ""
        patcher = patch.object(phone_calls, "live_problem", no_problem)
        patcher.start()
        self.stack.append(patcher)
        for account in ("acct1", "acct2"):
            connection.delete(account)
        phone_calls._tokens.clear()
        phone_calls._replays.items.clear()
        phone_calls._last_call.clear()
        phone_calls._pin_failures.clear()
        self.api = FakeProviderAPI()
        phone_calls.TRANSPORT = self.api.transport
        setup_accounts()

    async def asyncTearDown(self):
        phone_calls.TRANSPORT = None
        for patcher in reversed(self.stack):
            patcher.stop()

    # -- helpers -------------------------------------------------------------------------------

    def signed_voice(self, params, token=TOKEN_1, query="", url=None):
        url = url or (BASE + "/api/phone/twilio/voice" + (("?" + query) if query else ""))
        body = urlencode(params).encode()
        return {"X-Twilio-Signature": sign_twilio(token, url, params)}, query, body

    async def voice(self, params, **kwargs):
        headers, query, body = self.signed_voice(params, **kwargs)
        return await phone_calls.twilio_voice(headers, query, body)


class AudioTests(unittest.TestCase):
    def test_mulaw_round_trip_is_close_and_known_vectors_hold(self):
        t = np.arange(16000) / 16000
        pcm = (0.5 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
        encoded = phone_audio.mulaw_encode(pcm)
        self.assertEqual(len(encoded), len(pcm))
        decoded = phone_audio.mulaw_decode(encoded).astype(np.float32)
        error = decoded - pcm.astype(np.float32)
        snr = 10 * np.log10(np.mean(pcm.astype(np.float32) ** 2) / np.mean(error ** 2))
        self.assertGreater(snr, 30)
        self.assertEqual(phone_audio.mulaw_encode(np.array([0, -1, 1, 32767, -32768], dtype=np.int16)).hex(), "ff7fff8000")
        self.assertEqual(list(phone_audio.mulaw_decode(bytes([0xFF, 0x7F, 0x00, 0x80]))), [0, 0, -32124, 32124])

    def test_resample_round_trip_keeps_the_tone_and_chunking_changes_nothing(self):
        t = np.arange(16000) / 16000
        x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        down = phone_audio.resample(x, 16000, 8000)
        self.assertEqual(len(down), 8000)
        back = phone_audio.resample(down, 8000, 16000)
        best = max(np.corrcoef(back[200:-200], x[200 - lag:len(back) - 200 - lag])[0, 1] for lag in range(0, 60))
        self.assertGreater(best, 0.99)
        for source, target, size in ((16000, 8000, 333), (24000, 8000, 1000), (8000, 16000, 97), (16000, 24000, 333)):
            whole = phone_audio.resample(x, source, target)
            resampler = phone_audio.Resampler(source, target)
            chunked = np.concatenate([resampler.process(x[i:i + size]) for i in range(0, len(x), size)])
            n = min(len(whole), len(chunked))
            self.assertLessEqual(abs(len(whole) - len(chunked)), 1)
            self.assertLess(float(np.abs(whole[:n] - chunked[:n]).max()), 1e-4)

    def test_speech_to_phone_makes_exact_20ms_frames(self):
        pcm = phone_audio.float_to_pcm16(np.sin(2 * np.pi * 200 * np.arange(24000) / 24000) * 0.4)   # 1 s at 24 kHz
        converter = phone_audio.SpeechToPhone(24000)
        frames = converter.frames(pcm[:7001 * 2]) + converter.frames(pcm[7001 * 2:], final=True)
        self.assertTrue(all(len(f) == 160 for f in frames))
        self.assertAlmostEqual(len(frames), 50, delta=2)
        self.assertGreater(float(np.abs(phone_audio.mulaw_decode(frames[10])).max()), 3000)

    def test_phone_to_speech_doubles_the_rate(self):
        converter = phone_audio.PhoneToSpeech()
        out = b"".join(converter.feed(f) for f in frames_of(tone(1000)))
        self.assertAlmostEqual(len(out) / 2, 16000, delta=4)


class SignatureTests(unittest.TestCase):
    def test_twilio_valid_forged_missing_and_wrong_token(self):
        params = {"CallSid": "CA1", "From": MOBILE_1, "To": NUMBER_1}
        url = BASE + "/api/phone/twilio/voice"
        good = {"X-Twilio-Signature": sign_twilio(TOKEN_1, url, params)}
        providers.verify_twilio(TOKEN_1, url, params, good)
        for bad in ({}, {"X-Twilio-Signature": "AAAA"}, {"X-Twilio-Signature": sign_twilio(TOKEN_2, url, params)},
                    {"X-Twilio-Signature": sign_twilio(TOKEN_1, url + "?x=1", params)}):
            with self.assertRaises(providers.SignatureError):
                providers.verify_twilio(TOKEN_1, url, params, bad)
        with self.assertRaises(providers.SignatureError):
            providers.verify_twilio(TOKEN_1, url, {**params, "From": STRANGER}, good)   # a tampered parameter
        with self.assertRaises(providers.SignatureError):
            providers.verify_twilio("", url, params, good)

    def test_telnyx_valid_forged_stale(self):
        key = Ed25519PrivateKey.generate()
        public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
        body = b'{"data":{"event_type":"call.initiated"}}'
        now = int(time.time())

        def headers(stamp, payload=body, signer=key):
            return {"telnyx-timestamp": str(stamp),
                    "telnyx-signature-ed25519": base64.b64encode(signer.sign(str(stamp).encode() + b"|" + payload)).decode()}
        providers.verify_telnyx(public, body, headers(now))
        with self.assertRaises(providers.SignatureError):
            providers.verify_telnyx(public, body + b" ", headers(now))                       # altered body
        with self.assertRaises(providers.SignatureError):
            providers.verify_telnyx(public, body, headers(now, signer=Ed25519PrivateKey.generate()))   # another key
        with self.assertRaises(providers.SignatureError):
            providers.verify_telnyx(public, body, headers(now - 4000))                       # stale
        with self.assertRaises(providers.SignatureError):
            providers.verify_telnyx(public, body, {})
        with self.assertRaises(providers.SignatureError):
            providers.verify_telnyx("not base64!", body, headers(now))

    def test_replay_cache(self):
        cache = providers.ReplayCache(ttl=10)
        self.assertFalse(cache.seen("a", now=100))
        self.assertTrue(cache.seen("a", now=105))
        self.assertFalse(cache.seen("a", now=200))     # forgotten after the window


class ConnectionTests(PhoneTestCase):
    async def test_secrets_are_sealed_per_account_and_never_shown(self):
        raw = Path(connection._file("acct1", create=False)).read_text()
        self.assertNotIn(TOKEN_1, raw)
        record = connection.get("acct1")
        self.assertEqual(connection.secret(record, "auth_token", "acct1"), TOKEN_1)
        with self.assertRaises(InvalidToken):
            secret_storage.decrypt_for("acct2", record["secrets"]["auth_token"])
        shown = connection.public(record)
        self.assertNotIn("secrets", shown)
        self.assertNotIn(TOKEN_1, json.dumps(shown))
        self.assertTrue(shown["secrets_set"]["auth_token"])
        # An empty secret on update keeps the saved one.
        connection.save({"user_number": "+15557770009", "auth_token": ""}, account="acct1")
        self.assertEqual(connection.secret(connection.get("acct1"), "auth_token", "acct1"), TOKEN_1)

    async def test_routing_by_called_number_and_exclusive_numbers(self):
        self.assertEqual(connection.find_by_number(NUMBER_1)[0], "acct1")
        self.assertEqual(connection.find_by_number("+1 (555) 000-2222")[0], "acct2")
        self.assertIsNone(connection.find_by_number(STRANGER))
        with self.assertRaises(connection.PhoneError):
            connection.save({"provider": "twilio", "account_sid": "x", "auth_token": "y", "number": NUMBER_1, "user_number": STRANGER}, account="acct2")
        connection.save({"enabled": False}, account="acct1")
        self.assertIsNone(connection.find_by_number(NUMBER_1))     # nothing runs for a disabled connection

    async def test_validation(self):
        base = {"provider": "twilio", "account_sid": "x", "auth_token": "y", "number": "+15551230000", "user_number": "+15551239999"}
        for change in ({"number": "555-1212"}, {"user_number": ""}, {"user_number": "+15551230000"}, {"provider": "vonage"},
                       {"public_url": "http://insecure.example"}, {"public_url": "https://u:p@x.example"}, {"auth_token": ""}):
            values = {**base, **change}
            if change == {"auth_token": ""}:
                connection.delete("acct1")
            with self.assertRaises(connection.PhoneError, msg=str(change)):
                connection.save(values, account="acct1")
        setup_accounts()

    async def test_no_connection_no_service(self):
        connection.delete("acct1")
        self.assertIsNone(connection.find_by_number(NUMBER_1))
        status, *_ = await self.voice({"CallSid": "CA1", "From": MOBILE_1, "To": NUMBER_1, "Direction": "inbound"})
        self.assertEqual(status, 403)
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.call_user("acct1", "bot-kip", "hi", "inv-x")
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.text_user("acct1", "bot-kip", "hi", "inv-y")
        self.assertEqual(self.api.requests, [])


class InboundWebhookTests(PhoneTestCase):
    def call(self, sender=MOBILE_1, to=NUMBER_1, **extra):
        return {"CallSid": "CA" + uuid.uuid4().hex[:8], "From": sender, "To": to, "Direction": "inbound", **extra}

    async def test_the_verified_mobile_gets_a_stream_with_a_one_use_token(self):
        status, content, kind = await self.voice(self.call())
        text = content.decode()
        self.assertEqual((status, kind), (200, "application/xml"))
        self.assertIn('<Stream url="wss://kairos.example.net/api/phone/twilio/stream">', text)
        token = text.split('name="t" value="')[1].split('"')[0]
        self.assertEqual(phone_calls.redeem(token, "stream")["account"], "acct1")
        self.assertIsNone(phone_calls.redeem(token, "stream"))      # used
        self.assertEqual(self.api.requests, [])

    async def test_unknown_callers_hear_a_refusal_and_get_no_stream(self):
        for params in (self.call(sender=STRANGER), self.call(sender=""), self.call(sender=MOBILE_2),
                       self.call(StirVerstat="TN-Validation-Failed-C")):
            status, content, _ = await self.voice(params)
            text = content.decode()
            self.assertEqual(status, 200)
            self.assertIn("<Say>", text)
            self.assertIn("<Hangup/>", text)
            self.assertNotIn("<Stream", text)
        self.assertEqual(phone_calls._tokens, {})

    async def test_forged_unsigned_wrong_account_and_unknown_number_are_refused(self):
        params = self.call()
        url = BASE + "/api/phone/twilio/voice"
        body = urlencode(params).encode()
        self.assertEqual((await phone_calls.twilio_voice({}, "", body))[0], 403)                                   # unsigned
        self.assertEqual((await phone_calls.twilio_voice({"X-Twilio-Signature": "AAAA"}, "", body))[0], 403)       # forged
        other = {"X-Twilio-Signature": sign_twilio(TOKEN_2, url, params)}
        self.assertEqual((await phone_calls.twilio_voice(other, "", body))[0], 403)                                # another account's key
        self.assertEqual((await self.voice(self.call(to=STRANGER)))[0], 403)                                       # not anyone's number
        self.assertEqual(phone_calls._tokens, {})

    async def test_a_replayed_request_is_refused(self):
        headers, query, body = self.signed_voice(self.call())
        self.assertEqual((await phone_calls.twilio_voice(headers, query, body))[0], 200)
        self.assertEqual((await phone_calls.twilio_voice(headers, query, body))[0], 403)

    async def test_each_number_reaches_its_own_account(self):
        _, content, _ = await self.voice(self.call(sender=MOBILE_2, to=NUMBER_2), token=TOKEN_2)
        token = content.decode().split('name="t" value="')[1].split('"')[0]
        self.assertEqual(phone_calls.redeem(token, "stream")["account"], "acct2")
        # acct1's mobile calling acct2's number is a stranger there.
        _, content, _ = await self.voice(self.call(sender=MOBILE_1, to=NUMBER_2), token=TOKEN_2)
        self.assertIn("<Say>", content.decode())

    async def test_when_no_voice_is_ready_the_caller_is_told_instead_of_connected(self):
        async def problem(account, record, bot):
            return "Kairos has no local voice set up for calls yet. Goodbye."
        with patch.object(phone_calls, "live_problem", problem):
            _, content, _ = await self.voice(self.call())
        self.assertIn("no local voice", content.decode())
        self.assertNotIn("<Stream", content.decode())


class StreamTests(PhoneTestCase):
    async def mint(self, mode="inbound", message="", account="acct1"):
        return phone_calls.mint("stream", account, 60, mode=mode, message=message, bot_id="bot-kip")

    def handshake(self, token=TOKEN_1):
        return {"x-twilio-signature": sign_twilio(token, BASE.replace("https", "wss") + "/api/phone/twilio/stream", {})}

    async def run_stream(self, socket, pipeline=None):
        pipeline = pipeline or FakePipeline()

        async def factory(account, record, bot, session):
            return pipeline
        return pipeline, await phone_calls.serve_stream("twilio", socket, factory, {"pace": False})

    async def test_a_valid_stream_is_bridged_and_a_token_works_once(self):
        token = await self.mint()
        pipeline = FakePipeline()
        socket = FakeSocket([twilio_start(token), *[twilio_media(f) for f in silence(100)]], headers=self.handshake(),
                            stop_when=lambda: pipeline.announced and len(socket.media_sent()) > 5)
        _, result = await self.run_stream(socket, pipeline)
        self.assertEqual(result, "ended")
        self.assertTrue(pipeline.closed)
        self.assertEqual(pipeline.announced, ["Hi, it's Kip. How can I help?"])
        self.assertGreater(len(socket.media_sent()), 0)                 # the greeting went back as audio
        again = FakeSocket([twilio_start(token)], headers=self.handshake())
        _, result = await self.run_stream(again)
        self.assertEqual((result, again.closed), ("refused", 1008))

    async def test_bad_tokens_and_unsigned_handshakes_are_closed(self):
        for socket in (FakeSocket([twilio_start("nope")], headers=self.handshake()),
                       FakeSocket([json.dumps({"event": "media", "media": {"payload": ""}})] * 6, headers=self.handshake()),
                       FakeSocket([twilio_start(await self.mint())], headers={}),
                       FakeSocket([twilio_start(await self.mint())], headers=self.handshake(TOKEN_2))):
            pipeline = FakePipeline()
            _, result = await self.run_stream(socket, pipeline)
            self.assertEqual(socket.closed, 1008, result)
            self.assertEqual(socket.sent, [])
            self.assertEqual(pipeline.announced, [])

    async def test_a_disabled_connection_refuses_a_stream(self):
        token = await self.mint()
        connection.save({"enabled": False}, account="acct1")
        socket = FakeSocket([twilio_start(token)], headers=self.handshake())
        _, result = await self.run_stream(socket)
        self.assertEqual((result, socket.closed), ("refused", 1008))

    async def test_an_outbound_call_opens_with_the_ai_disclosure(self):
        token = await self.mint("outbound", "The nightly report is ready.")
        pipeline = FakePipeline()
        socket = FakeSocket([twilio_start(token)], headers=self.handshake(), stop_when=lambda: pipeline.announced)
        await self.run_stream(socket, pipeline)
        self.assertEqual(pipeline.announced, ["This is Kip, an AI assistant from Kairos. The nightly report is ready."])


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pipeline = FakePipeline()
        self.socket = FakeSocket()
        self.inbound = asyncio.Queue()
        self.provider = providers.Twilio({}, {})

    async def start(self, **options):
        self.bridge = phone_bridge.PhoneBridge(self.provider, self.socket.send, self.pipeline, stream_id="MZ1", pace=False, **options)
        self.task = asyncio.create_task(self.bridge.run(self.inbound.get))

    async def feed(self, frames):
        for frame in frames:        # one frame per loop turn, so a Smart Turn answer lands between frames like it would live
            await self.inbound.put(twilio_media(frame))
            await asyncio.sleep(0)
            await asyncio.sleep(0)

    async def finish(self):
        await self.inbound.put(None)
        await asyncio.wait_for(self.task, 5)

    async def say(self, ms=600):
        """A short utterance preceded by the quiet the endpointer calibrates on."""
        await self.feed(silence(300) + frames_of(tone(ms)))

    async def test_a_turn_runs_end_to_end_and_audio_comes_back(self):
        await self.start()
        await self.say()
        await self.feed(silence(900))
        self.assertTrue(await Settled.until(lambda: len(self.socket.media_sent()) > 10))
        await self.finish()
        self.assertEqual(len(self.pipeline.heard), 1)
        wav_seconds = len(self.pipeline.heard[0]) / 2 / 16000                    # the STT got 16 kHz audio of the utterance
        self.assertGreater(wav_seconds, 0.5)
        self.assertLess(wav_seconds, 1.4)
        self.assertEqual(self.pipeline.spoken, ["Sure thing.", "I can do that for you."])   # the first sentence goes alone
        media = self.socket.media_sent()
        self.assertTrue(all(m["streamSid"] == "MZ1" for m in media))
        payloads = [base64.b64decode(m["media"]["payload"]) for m in media]
        self.assertTrue(all(len(p) == 160 for p in payloads))
        energy = max(float(np.abs(phone_audio.mulaw_decode(p)).max()) for p in payloads)
        self.assertGreater(energy, 3000)
        self.assertAlmostEqual(len(payloads) * 0.02, 0.4 * len(self.pipeline.spoken), delta=0.05)   # 0.4 s per sentence, as 20 ms frames
        self.assertTrue(self.pipeline.closed)

    async def test_the_opening_line_is_spoken_before_the_caller_says_anything(self):
        await self.start(opening="This is Kip, an AI assistant from Kairos. Your build finished.")
        self.assertTrue(await Settled.until(lambda: len(self.socket.media_sent()) > 5))
        await self.finish()
        self.assertEqual(self.pipeline.announced, ["This is Kip, an AI assistant from Kairos. Your build finished."])
        self.assertEqual(" ".join(self.pipeline.spoken), "This is Kip, an AI assistant from Kairos. Your build finished.")

    async def test_talking_over_the_bot_stops_it_and_a_short_mmhm_does_not(self):
        self.pipeline.gate = asyncio.Event()                    # the bot stays mid-sentence
        await self.start()
        await self.say()
        await self.feed(silence(900))
        self.assertTrue(await Settled.until(lambda: self.bridge.phase == "speaking" and self.socket.media_sent()))
        before = len(self.pipeline.heard)
        # a 200 ms "mm-hm": no interruption, no new turn
        await self.feed(frames_of(tone(200)) + silence(900))
        await asyncio.sleep(0.05)
        self.assertEqual([m for m in self.socket.sent if m["event"] == "clear"], [])
        self.assertEqual(self.pipeline.interrupts, [])
        self.assertEqual(len(self.pipeline.heard), before)
        # sustained speech: barge-in
        await self.feed(frames_of(tone(700)))
        self.assertTrue(await Settled.until(lambda: any(m["event"] == "clear" for m in self.socket.sent)))
        self.assertEqual(self.pipeline.interrupts[-1], True)
        self.assertTrue([m for m in self.socket.sent if m["event"] == "clear"][0]["streamSid"] == "MZ1")
        # ...and what they said becomes the next turn
        await self.feed(silence(900))
        self.assertTrue(await Settled.until(lambda: len(self.pipeline.heard) == before + 1))
        self.pipeline.gate.set()
        await self.finish()

    async def test_smart_turn_ends_a_finished_sentence_early_and_waits_for_an_unfinished_one(self):
        await self.start(smart_turn=True)
        self.pipeline.verdict = True
        await self.say()
        await self.feed(silence(300))                           # far short of the 700 ms silence wait
        self.assertTrue(await Settled.until(lambda: len(self.pipeline.heard) == 1))
        self.assertTrue(self.pipeline.asked)
        # an unfinished sentence: the verdict is "not yet", so 1 s of quiet is not the end
        self.pipeline.verdict = False
        await self.say()
        await self.feed(silence(1000))
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.pipeline.heard), 1)
        await self.feed(silence(1700))                          # past the 2.5 s cap
        self.assertTrue(await Settled.until(lambda: len(self.pipeline.heard) == 2))
        await self.finish()

    async def test_without_a_verdict_it_falls_back_to_the_silence_wait(self):
        await self.start(smart_turn=True)
        self.pipeline.verdict = None
        await self.say()
        await self.feed(silence(300))
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.pipeline.heard), 0)
        await self.feed(silence(500))
        self.assertTrue(await Settled.until(lambda: len(self.pipeline.heard) == 1))
        await self.finish()

    async def test_noise_and_silence_start_no_turn(self):
        await self.start()
        await self.feed(silence(1500) + frames_of(tone(60)) + silence(1000))
        await asyncio.sleep(0.1)
        await self.finish()
        self.assertEqual(self.pipeline.heard, [])


class OutboundTests(PhoneTestCase):
    async def test_a_bot_calls_only_the_verified_number_and_opens_with_the_disclosure(self):
        line = await phone_calls.call_user("acct1", "bot-kip", "The report is ready.", "inv-1")
        self.assertIn("This is Kip, an AI assistant from Kairos.", line)
        request = self.api.requests[-1]
        self.assertIn("/Accounts/ACone/Calls.json", request["url"])
        form = self.api.form()
        self.assertEqual((form["To"], form["From"]), (MOBILE_1, NUMBER_1))
        self.assertTrue(form["Url"].startswith(BASE + "/api/phone/twilio/voice?out="))
        # the provider's answer-fetch for that call: signed, outbound, to the user's number
        token = form["Url"].split("out=")[1]
        params = {"CallSid": "CAfake", "From": NUMBER_1, "To": MOBILE_1, "Direction": "outbound-api"}
        headers, query, body = self.signed_voice(params, query="out=" + token)
        status, content, _ = await phone_calls.twilio_voice(headers, query, body)
        self.assertEqual(status, 200)
        self.assertIn("<Stream", content.decode())
        stream_token = content.decode().split('name="t" value="')[1].split('"')[0]
        session = phone_calls.redeem(stream_token, "stream")
        self.assertEqual((session["mode"], session["message"]), ("outbound", "The report is ready."))
        # the same intent cannot be used twice, even by a request with a fresh valid signature
        params2 = {**params, "CallSid": "CAother"}
        headers, query, body = self.signed_voice(params2, query="out=" + token)
        status, content, _ = await phone_calls.twilio_voice(headers, query, body)
        self.assertIn("<Say>", content.decode())
        self.assertNotIn("<Stream", content.decode())

    async def test_the_number_cannot_be_chosen_and_other_destinations_are_refused(self):
        import inspect
        self.assertEqual(list(inspect.signature(phone_calls.call_user).parameters), ["account", "bot_id", "message", "invocation_id"])
        self.assertNotIn("number", json.dumps(phone_tools.TOOLS[0]["schema"]))
        # a provider fetch that asks the bot to talk to someone else's number is refused
        await phone_calls.call_user("acct1", "bot-kip", "Hi", "inv-1")
        token = self.api.form()["Url"].split("out=")[1]
        params = {"CallSid": "CAx", "From": NUMBER_1, "To": STRANGER, "Direction": "outbound-api"}
        headers, query, body = self.signed_voice(params, query="out=" + token)
        _, content, _ = await phone_calls.twilio_voice(headers, query, body)
        self.assertNotIn("<Stream", content.decode())

    async def test_rate_limits_cooldown_and_daily_caps(self):
        await phone_calls.call_user("acct1", "bot-kip", "one", "inv-1")
        with self.assertRaises(phone_calls.PhoneRefused) as caught:
            await phone_calls.call_user("acct1", "bot-kip", "two", "inv-2")
        self.assertIn("moment ago", str(caught.exception))
        for n in range(2, 4):
            phone_calls._last_call.clear()
            await phone_calls.call_user("acct1", "bot-kip", f"call {n}", f"inv-{n}")
        phone_calls._last_call.clear()
        with self.assertRaises(phone_calls.PhoneRefused) as caught:
            await phone_calls.call_user("acct1", "bot-kip", "four", "inv-4")
        self.assertIn("limit", str(caught.exception))
        calls_placed = [r for r in self.api.requests if r["url"].endswith("Calls.json")]
        self.assertEqual(len(calls_placed), 3)
        # a retry of the same invocation reuses its unit instead of failing
        phone_calls._last_call.clear()
        await phone_calls.call_user("acct1", "bot-kip", "retry", "inv-3")
        # another bot has its own allowance, but the account-wide one (6) still applies
        for n in range(3):
            phone_calls._last_call.clear()
            await phone_calls.call_user("acct1", "bot-other", f"other {n}", f"other-{n}")
        phone_calls._last_call.clear()
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.call_user("acct1", "bot-third", "x", "third-1")
        # another account is untouched
        await phone_calls.call_user("acct2", "bot-kip", "separate", "acct2-1")
        self.assertEqual(self.api.form()["To"], MOBILE_2)

    async def test_a_provider_refusal_releases_the_unit_and_the_cooldown(self):
        phone_calls.TRANSPORT = httpx.MockTransport(lambda request: httpx.Response(401, json={"message": "no"}))
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.call_user("acct1", "bot-kip", "hi", "inv-1")
        self.assertNotIn("acct1", phone_calls._last_call)
        usage = bot_outbound.usage("acct1", "phone:bot-kip:call", 3)
        self.assertEqual(usage["used"], 0)

    async def test_text_goes_to_the_verified_number_through_the_phone_connection(self):
        line = await phone_calls.text_user("acct1", "bot-kip", "Build finished.", "t-1")
        self.assertIn("Text sent", line)
        self.assertIn("/Accounts/ACone/Messages.json", self.api.requests[-1]["url"])
        form = self.api.form()
        self.assertEqual((form["To"], form["From"], form["Body"]), (MOBILE_1, NUMBER_1, "Build finished."))
        for n in range(9):
            await phone_calls.text_user("acct1", "bot-kip", "again", f"t-{n + 2}")
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.text_user("acct1", "bot-kip", "too many", "t-last")

    async def test_text_uses_the_accounts_twilio_sms_connector_when_it_has_one(self):
        from core.connectors import KINDS, hub, store
        with accounts.as_account("acct1"):
            record = store.create("sms", "My SMS", {"account_sid": "ACsms", "auth_token": "smstoken", "from_number": "+15550003333",
                                                    "public_url": BASE + "/x", "default_to": MOBILE_1},
                                  KINDS["sms"].fields, [MOBILE_1], False, None)
        old = hub.transport
        hub.transport = self.api.transport
        try:
            await phone_calls.text_user("acct1", "bot-kip", "via connector", "t-1")
        finally:
            hub.transport = old
            store.delete(record["id"])
        self.assertIn("/Accounts/ACsms/Messages.json", self.api.requests[-1]["url"])
        self.assertEqual(self.api.form()["To"], MOBILE_1)
        self.assertEqual(self.api.form()["From"], "+15550003333")

    async def test_the_tools_are_registered_outbound_and_refuse_without_a_connection(self):
        from core import bot_policy, tool_registry
        for name in ("notify_me_by_call", "notify_me_by_text"):
            self.assertIn(name, tool_registry._REGISTRY)
            self.assertEqual(bot_policy.classify(name, {"message": "x"}).kind, bot_policy.OUTBOUND)
        connection.delete("acct2")
        with accounts.as_account("acct2"):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", owner_user="local", invocation_id="inv-9")
            result = await phone_tools.tool_call({"message": "hello"}, ctx)
        self.assertTrue(result.startswith("Not sent:"), result)
        with accounts.as_account("acct1"):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", owner_user="local", invocation_id="inv-10")
            result = await phone_tools.tool_text({"message": "hello"}, ctx)
        self.assertEqual(result, "Text sent to your phone.")


class TelnyxTests(PhoneTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.key = Ed25519PrivateKey.generate()
        public = base64.b64encode(self.key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
        connection.save({"provider": "telnyx", "api_key": "KEYsecret", "public_key": public, "connection_id": "conn-1",
                         "number": "+15550004444", "user_number": MOBILE_1, "public_url": BASE, "conversation_endpoint_id": "fast",
                         "conversation_model": "small", "require_pin": False}, account="acct1")
        connection.delete("acct2")

    def event(self, kind, **payload):
        body = json.dumps({"data": {"event_type": kind, "payload": {"call_control_id": "cc1", **payload}}}).encode()
        stamp = str(int(time.time()))
        return {"telnyx-timestamp": stamp, "telnyx-signature-ed25519": base64.b64encode(self.key.sign(stamp.encode() + b"|" + body)).decode()}, body

    async def test_inbound_from_the_verified_mobile_is_answered_with_a_stream(self):
        headers, body = self.event("call.initiated", direction="incoming", **{"from": MOBILE_1, "to": "+15550004444"})
        self.assertEqual((await phone_calls.telnyx_event(headers, body))[0], 200)
        request = self.api.requests[-1]
        self.assertTrue(request["url"].endswith("/v2/calls/cc1/actions/answer"))
        self.assertEqual(request["headers"]["authorization"], "Bearer KEYsecret")
        sent = self.api.json()
        self.assertTrue(sent["stream_url"].startswith("wss://kairos.example.net/api/phone/telnyx/stream?t="))
        self.assertIsNotNone(phone_calls.redeem(sent["stream_url"].split("t=")[1], "stream"))
        self.assertEqual((await phone_calls.telnyx_event(headers, body))[0], 403)      # replay

    async def test_strangers_forgeries_and_wrong_numbers_are_refused(self):
        headers, body = self.event("call.initiated", direction="incoming", **{"from": STRANGER, "to": "+15550004444"})
        await phone_calls.telnyx_event(headers, body)
        self.assertNotIn("stream_url", self.api.requests[-1]["body"])
        self.assertEqual(self.api.json()["client_state"], base64.b64encode(b"refuse").decode())
        count = len(self.api.requests)
        headers2, body2 = self.event("call.answered", direction="incoming", client_state=base64.b64encode(b"refuse").decode(),
                                     **{"from": STRANGER, "to": "+15550004444"})
        await phone_calls.telnyx_event(headers2, body2)
        self.assertTrue(self.api.requests[-1]["url"].endswith("/actions/speak"))
        self.assertGreater(len(self.api.requests), count)
        # forged and unknown
        self.assertEqual((await phone_calls.telnyx_event({}, body))[0], 403)
        forged_headers = {**headers, "telnyx-signature-ed25519": base64.b64encode(b"x" * 64).decode()}
        self.assertEqual((await phone_calls.telnyx_event(forged_headers, body))[0], 403)
        h3, b3 = self.event("call.initiated", direction="incoming", **{"from": MOBILE_1, "to": "+15550009999"})
        self.assertEqual((await phone_calls.telnyx_event(h3, b3))[0], 403)

    async def test_outbound_call_dials_the_verified_number_then_starts_the_stream_when_answered(self):
        await phone_calls.call_user("acct1", "bot-kip", "Urgent: disk is full.", "inv-1")
        sent = self.api.json()
        self.assertEqual((sent["to"], sent["from"], sent["connection_id"]), (MOBILE_1, "+15550004444", "conn-1"))
        state = sent["client_state"]
        headers, body = self.event("call.answered", direction="outgoing", client_state=state, **{"from": "+15550004444", "to": MOBILE_1})
        self.assertEqual((await phone_calls.telnyx_event(headers, body))[0], 200)
        self.assertTrue(self.api.requests[-1]["url"].endswith("/actions/streaming_start"))
        session = phone_calls.redeem(self.api.json()["stream_url"].split("t=")[1], "stream")
        self.assertEqual((session["mode"], session["message"]), ("outbound", "Urgent: disk is full."))

    async def test_a_telnyx_stream_authenticates_by_its_query_token(self):
        token = phone_calls.mint("stream", "acct1", 60, mode="inbound", message="", bot_id="bot-kip")
        start = json.dumps({"event": "start", "stream_id": "st1", "start": {"call_control_id": "cc1"}})
        pipeline = FakePipeline()
        socket = FakeSocket([start], query={"t": token}, stop_when=lambda: len(socket.media_sent()) > 5)

        async def factory(account, record, bot, session):
            return pipeline
        result = await phone_calls.serve_stream("telnyx", socket, factory, {"pace": False})
        self.assertEqual(result, "ended")
        self.assertGreater(len(socket.media_sent()), 0)
        self.assertNotIn("streamSid", socket.media_sent()[0])      # Telnyx frames have the Telnyx shape


PIN = "4821"


class PinTests(PhoneTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        connection.save({"require_pin": True, "pin": PIN}, account="acct1")

    def call(self, **extra):
        return {"CallSid": "CA" + uuid.uuid4().hex[:8], "From": MOBILE_1, "To": NUMBER_1, "Direction": "inbound", **extra}

    async def gather(self, digits, attempt=1):
        return await self.voice(self.call(Digits=digits), query=f"pin=1&n={attempt}")

    async def test_the_pin_is_required_by_default_and_never_shown_back(self):
        connection.delete("acct2")
        connection.save({"provider": "twilio", "account_sid": "x", "auth_token": "y", "number": "+15550006666",
                         "user_number": "+15550007777"}, account="acct2")
        fresh = connection.get("acct2")
        self.assertTrue(connection.pin_required(fresh))
        self.assertFalse(connection.public(fresh)["pin_set"])
        shown = connection.public(connection.get("acct1"))
        self.assertTrue(shown["pin_set"])
        self.assertNotIn("pin_hash", shown)
        self.assertNotIn(PIN, json.dumps(shown))
        self.assertNotIn(PIN, Path(connection._file("acct1", create=False)).read_text())
        for bad in ("123", "123456789", "12ab"):
            with self.assertRaises(connection.PhoneError):
                connection.save({"pin": bad}, account="acct1")

    async def test_a_call_with_no_pin_set_is_refused(self):
        connection.delete("acct2")
        connection.save({"provider": "twilio", "account_sid": "x", "auth_token": TOKEN_2, "number": NUMBER_2,
                         "user_number": MOBILE_2, "public_url": BASE}, account="acct2")
        _, content, _ = await self.voice(self.call(From=MOBILE_2, To=NUMBER_2), token=TOKEN_2)
        self.assertNotIn("<Stream", content.decode())
        self.assertIn("none is set", content.decode())

    async def test_correct_pin_bridges_and_the_call_is_not_bridged_before_it(self):
        _, content, _ = await self.voice(self.call())
        text = content.decode()
        self.assertIn('<Gather input="dtmf"', text)
        self.assertNotIn("<Stream", text)
        self.assertEqual(phone_calls._tokens, {})
        _, content, _ = await self.gather(PIN + "#")
        self.assertIn("<Stream", content.decode())
        self.assertNotIn(PIN, content.decode())

    async def test_wrong_pin_gets_three_tries_then_goodbye(self):
        for attempt in (1, 2):
            _, content, _ = await self.gather("0000", attempt)
            self.assertIn("<Gather", content.decode())
            self.assertIn(f"n={attempt + 1}", content.decode())
        _, content, _ = await self.gather("1111", 3)
        self.assertNotIn("<Gather", content.decode())
        self.assertNotIn("<Stream", content.decode())
        self.assertIn("<Hangup/>", content.decode())
        self.assertEqual(phone_calls._tokens, {})

    async def test_five_wrong_tries_lock_the_account_even_for_the_right_pin(self):
        for attempt in (1, 2, 3):
            await self.gather("0000", attempt)
        await self.gather("0000", 1)
        _, content, _ = await self.gather("0000", 2)        # the fifth
        self.assertIn("<Say>", content.decode())
        _, content, _ = await self.gather(PIN, 1)
        self.assertNotIn("<Stream", content.decode())
        _, content, _ = await self.voice(self.call())        # a fresh call is not even asked
        self.assertNotIn("<Gather", content.decode())
        phone_calls._pin_failures["acct1"] = [time.time() - 4000] * 5       # an hour later it opens again
        _, content, _ = await self.gather(PIN, 1)
        self.assertIn("<Stream", content.decode())

    async def test_the_pin_is_never_logged(self):
        with self.assertLogs("services.phone_calls", level="DEBUG") as logs:
            await self.gather("9999")
            await self.gather(PIN)
            phone_calls.logger.info("end")
        joined = "\n".join(logs.output)
        self.assertNotIn(PIN, joined)
        self.assertNotIn("9999", joined)

    async def test_strangers_are_refused_before_any_pin_is_asked(self):
        _, content, _ = await self.voice(self.call(From=STRANGER))
        self.assertNotIn("<Gather", content.decode())

    async def test_outbound_calls_skip_the_pin(self):
        await phone_calls.call_user("acct1", "bot-kip", "Report ready.", "inv-1")
        token = self.api.form()["Url"].split("out=")[1]
        params = {"CallSid": "CAo", "From": NUMBER_1, "To": MOBILE_1, "Direction": "outbound-api"}
        headers, query, body = self.signed_voice(params, query="out=" + token)
        _, content, _ = await phone_calls.twilio_voice(headers, query, body)
        self.assertIn("<Stream", content.decode())
        self.assertNotIn("<Gather", content.decode())

    async def test_turning_the_pin_off_is_explicit(self):
        connection.save({"require_pin": False}, account="acct1")
        _, content, _ = await self.voice(self.call())
        self.assertIn("<Stream", content.decode())
        self.assertFalse(connection.public(connection.get("acct1"))["require_pin"])

    async def test_telnyx_asks_for_the_pin_on_the_keypad_then_streams(self):
        t = TelnyxTests("test_inbound_from_the_verified_mobile_is_answered_with_a_stream")
        await t.asyncSetUp()
        try:
            connection.save({"require_pin": True, "pin": PIN}, account="acct1")
            mobile, mine = MOBILE_1, "+15550004444"
            h, b = t.event("call.initiated", direction="incoming", **{"from": mobile, "to": mine})
            await phone_calls.telnyx_event(h, b)
            self.assertNotIn("stream_url", t.api.requests[-1]["body"])
            state = t.api.json()["client_state"]
            h, b = t.event("call.answered", direction="incoming", client_state=state, **{"from": mobile, "to": mine})
            await phone_calls.telnyx_event(h, b)
            self.assertTrue(t.api.requests[-1]["url"].endswith("/actions/gather_using_speak"))
            state = t.api.json()["client_state"]
            h, b = t.event("call.gather.ended", direction="incoming", client_state=state, digits="0000", **{"from": mobile, "to": mine})
            await phone_calls.telnyx_event(h, b)
            self.assertTrue(t.api.requests[-1]["url"].endswith("/actions/gather_using_speak"))      # asked again
            state = t.api.json()["client_state"]
            h, b = t.event("call.gather.ended", direction="incoming", client_state=state, digits=PIN, **{"from": mobile, "to": mine})
            await phone_calls.telnyx_event(h, b)
            self.assertTrue(t.api.requests[-1]["url"].endswith("/actions/streaming_start"))
        finally:
            await t.asyncTearDown()


class RouteTests(PhoneTestCase):
    def client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core.middleware import require_user
        from routes.phone_routes import router
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_user] = lambda: "local"
        return TestClient(app)

    def test_settings_never_return_secrets_and_the_webhook_is_public(self):
        with patch.object(accounts, "effective_account", lambda: "acct1"):
            client = self.client()
            shown = client.get("/api/phone").json()["connection"]
            self.assertTrue(shown["configured"])
            self.assertNotIn(TOKEN_1, json.dumps(shown))
            self.assertEqual(shown["webhook_paths"]["voice"], BASE + "/api/phone/twilio/voice")
            bad = client.put("/api/phone", json={"number": "nope"})
            self.assertEqual(bad.status_code, 422)
        params = {"CallSid": "CA1", "From": MOBILE_1, "To": NUMBER_1, "Direction": "inbound"}
        body = urlencode(params)
        sig = sign_twilio(TOKEN_1, BASE + "/api/phone/twilio/voice", params)
        client = self.client()
        forged = client.post("/api/phone/twilio/voice", content=body, headers={"content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "AAAA"})
        self.assertEqual(forged.status_code, 403)
        ok = client.post("/api/phone/twilio/voice", content=body, headers={"content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig})
        self.assertEqual(ok.status_code, 200)
        self.assertIn("<Stream", ok.text)

    def test_websocket_with_a_bad_token_is_closed(self):
        from starlette.websockets import WebSocketDisconnect
        client = self.client()
        with client.websocket_connect("/api/phone/twilio/stream") as socket:
            socket.send_text(twilio_start("not-a-token"))
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_text()


class LivePipelineTests(PhoneTestCase):
    async def test_live_pipeline_runs_the_call_pipeline_and_ends_the_call(self):
        from core import session_manager_store as store
        from core.session_manager import session_manager
        from services import agent_calls
        from services.agent_service import agent_service

        class FakeConversation:
            def __init__(self, *args):
                pass

            async def close(self):
                pass

            async def stream(self, messages, max_tokens=320):
                if max_tokens != 320:
                    yield "Phone call notes."
                    return
                yield "I can help. "
                yield "Tell me more."
        temp = tempfile.TemporaryDirectory()
        agent = agent_service.create("Phone " + uuid.uuid4().hex[:10], endpoint_id=None)
        parent = session_manager.create_session(owner_user="local")["id"]
        value = session_manager.get_session(parent)
        value["agent_id"] = agent["id"]
        value["model_endpoint_id"] = "strong"
        store.save_session(value)
        with patch.object(agent_calls, "ROOT", Path(temp.name)), patch.object(agent_calls, "Conversation", FakeConversation), \
                patch.object(phone_calls, "_thread_for", lambda bot, owner: parent):
            pipeline = await phone_calls.LivePipeline.open("acct1", connection.get("acct1"), {**BOT, "id": agent["id"]}, {})
            await pipeline.announce("This is Kip, an AI assistant from Kairos.", "open:1")
            deltas = [d async for d in pipeline.converse("hello", "r1")]
            self.assertEqual("".join(deltas), "I can help. Tell me more.")
            call = pipeline.call
            self.assertEqual([m["role"] for m in call["messages"]], ["assistant", "user", "assistant"])
            pipeline.touch()
            await pipeline.close()
            self.assertTrue(call["ended"])
            await asyncio.gather(*list(agent_calls._summaries.values()), return_exceptions=True)
            agent_calls._calls.clear()
        temp.cleanup()


if __name__ == "__main__":
    unittest.main()
