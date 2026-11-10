"""The one Voice choice (Settings > Speech) and its engines, against MOCK servers on 127.0.0.1 only (a small HTTP server
per test that speaks just enough of each API). Nothing reaches ElevenLabs, OpenAI or any real Voicebox.

Proves our side: keys sealed per account and never shown; ElevenLabs' streaming text-to-speech with xi-api-key and
pcm_24000; Voicebox (a mock written from its route code at 8af7efe6: /health, /profiles, /generate/stream returning the
whole clip as WAV, and the queued /generate + SSE status + /audio/{id} path) rendered one sentence per request and
handed out in 100 ms pieces; "Check" spending nothing; the Kokoro fallback when an engine fails; the migration of older
settings (VoiceStudio to Kairos Voice with a notice); the compatible server's missing voice list; GPT-Live's one-step
OpenAI key; and that bots, voice notes and phone calls speak through the chosen Voice.
Run: python scripts/test_voice_engines.py
"""
import asyncio
import json
import struct
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

_DATA = tempfile.TemporaryDirectory(prefix="kairos-voice-engines-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import accounts, call_voices, elevenlabs_voice, kokoro_voice, openai_key, voice_keys, voicebox_voice  # noqa: E402
from core.atomic_io import read_json, write_json_atomic  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import voice_engine_routes  # noqa: E402
from services import bot_voice  # noqa: E402

EL_KEY = "sk_test_ELEVEN_secret_0123456789abcdef"
OPENAI_KEY = "sk-test-OPENAI-secret-0123456789abcdef"
VOICE = "21m00Tcm4TlvDq8ikWAM"
PCM = bytes(range(256)) * 40          # 10,240 bytes, sent in four chunks


class MockServer:
    """A loopback HTTP server with a route table: (method, path) -> handler(request) -> (status, headers, body | [chunks])."""

    def __init__(self, routes):
        self.routes, self.requests = routes, []
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _serve(self, method):
                parts = urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                request = {"method": method, "path": parts.path, "query": {k: v[0] for k, v in parse_qs(parts.query).items()},
                           "headers": {k.lower(): v for k, v in self.headers.items()}, "json": json.loads(body) if body else None}
                server.requests.append(request)
                handler = server.routes.get((method, parts.path))
                status, headers, payload = handler(request) if handler else (404, {}, b'{"detail":"not found"}')
                self.send_response(status)
                for name, value in {"Content-Type": "application/json", **headers}.items():
                    self.send_header(name, value)
                if isinstance(payload, list):                       # streamed: chunked transfer, as both APIs do
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    for chunk in payload:
                        self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                else:
                    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

            def do_GET(self):
                self._serve("GET")

            def do_POST(self):
                self._serve("POST")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def of(self, path):
        return [r for r in self.requests if r["path"] == path]


def chunks(data, size=2560):
    return [data[i:i + size] for i in range(0, len(data), size)]


def eleven_routes(key=EL_KEY, out_of_credits=False):
    def authed(request):
        return request["headers"].get("xi-api-key") == key

    def voices(request):
        if not authed(request):
            return 401, {}, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}
        if request["query"].get("next_page_token") == "p2":
            return 200, {}, {"voices": [{"voice_id": "AZnzlk1XvdvUeBnXmlld", "name": "Domi", "category": "premade"}],
                             "has_more": False, "total_count": 3, "next_page_token": None}
        return 200, {}, {"voices": [{"voice_id": VOICE, "name": "Rachel", "category": "premade"},
                                    {"voice_id": "MyClone0123456789abc", "name": "Me", "category": "cloned"},
                                    {"voice_id": "../../etc", "name": "Bad"}],
                         "has_more": request["query"].get("page_size") != "1", "total_count": 3, "next_page_token": "p2"}

    def subscription(request):
        if not authed(request):
            return 401, {}, {"detail": {"status": "invalid_api_key"}}
        return 200, {}, {"character_count": 1200, "character_limit": 10000}

    def speak(request):
        if not authed(request):
            return 401, {}, {"detail": {"status": "invalid_api_key"}}
        if out_of_credits:
            return 401, {}, {"detail": {"status": "quota_exceeded", "message": "You have 0 credits remaining"}}
        return 200, {"Content-Type": "audio/pcm"}, chunks(PCM)
    return {("GET", "/v2/voices"): voices, ("GET", "/v1/user/subscription"): subscription,
            ("POST", f"/v1/text-to-speech/{VOICE}/stream"): speak}


def wav(pcm16: bytes, rate=24000, channels=1, float32=False) -> bytes:
    """A WAV file as soundfile writes one (Voicebox's tts.audio_to_wav_bytes): PCM 16 by default, or 32-bit float."""
    if float32:
        import numpy as np
        data = (np.frombuffer(pcm16, "<i2").astype(np.float32) / 32768).astype("<f4").tobytes()
        tag, bits = 3, 32
    else:
        data, tag, bits = pcm16, 1, 16
    if channels == 2:
        width = bits // 8
        data = b"".join(data[i:i + width] * 2 for i in range(0, len(data), width))
    fmt = struct.pack("<HHIIHH", tag, channels, rate, rate * channels * bits // 8, channels * bits // 8, bits)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


PROFILES = [{"id": "prof-1", "name": "My voice", "description": None, "language": "en", "voice_type": "cloned",
             "default_engine": "chatterbox_turbo", "generation_count": 0, "sample_count": 1,
             "created_at": "2026-11-10T00:00:00", "updated_at": "2026-11-10T00:00:00"},
            {"id": "prof-2", "name": "Narrateur", "description": None, "language": "fr", "voice_type": "preset",
             "preset_engine": "kokoro", "preset_voice_id": "ff_siwis", "created_at": "2026-11-10T00:00:00",
             "updated_at": "2026-11-10T00:00:00"}]


def voicebox_routes(stream_route=True, clip=None):
    """Voicebox's REST server as its source describes it (backend/routes/health.py, profiles.py, generations.py, audio.py)."""
    clip = clip or wav(PCM)

    def health(request):
        return 200, {}, {"status": "healthy", "model_loaded": False, "model_downloaded": None, "model_size": None,
                         "gpu_available": True, "gpu_type": "CUDA", "vram_used_mb": None, "backend_type": "pytorch",
                         "backend_variant": "cuda", "supports_rocm": False, "gpu_compatibility_warning": None,
                         "cloud_enabled": False}

    def generate_stream(request):
        body = request["json"] or {}
        if body.get("profile_id") not in {p["id"] for p in PROFILES}:
            return 404, {}, {"detail": "Profile not found"}
        if body.get("engine") == "omnivoice":
            return 400, {}, {"detail": "Engine omnivoice cannot use a cloned profile"}
        # Rendered whole, then sent in 64 KB slices (generations.py stream_speech).
        return 200, {"Content-Type": "audio/wav"}, [clip[i:i + 65536] for i in range(0, len(clip), 65536)]

    def generate(request):
        body = request["json"] or {}
        if body.get("profile_id") not in {p["id"] for p in PROFILES}:
            return 404, {}, {"detail": "Profile not found"}
        return 200, {}, {"id": "gen-1", "profile_id": body["profile_id"], "text": body["text"], "language": "en",
                         "status": "generating", "created_at": "2026-11-10T00:00:00"}

    def status(request):
        events = [{"id": "gen-1", "status": s, "duration": None, "error": None, "source": "manual"}
                  for s in ("loading_model", "generating", "completed")]
        return 200, {"Content-Type": "text/event-stream"}, [f"data: {json.dumps(e)}\n\n".encode() for e in events]

    routes = {("GET", "/health"): health, ("GET", "/profiles"): lambda r: (200, {}, json.dumps(PROFILES).encode()),
              ("POST", "/generate"): generate, ("GET", "/generate/gen-1/status"): status,
              ("GET", "/audio/gen-1"): lambda r: (200, {"Content-Type": "audio/wav"}, clip)}
    if stream_route:
        routes[("POST", "/generate/stream")] = generate_stream
    return routes


class EngineCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.account = "ve" + os.urandom(3).hex()
        self.token = accounts.set_current(self.account)
        self.patches = [patch.object(call_voices, "SETTINGS", os.path.join(self.dir.name, "voice.json")),
                        patch.object(voice_keys, "PATH", os.path.join(self.dir.name, "keys.json")),
                        patch.object(kokoro_voice, "ready", lambda: (False, "Kokoro is not downloaded"))]
        for item in self.patches:
            item.start()
        self.servers = []

    def tearDown(self):
        for item in self.patches:
            item.stop()
        for server in self.servers:
            server.stop()
        elevenlabs_voice.BASE = "https://api.elevenlabs.io"
        accounts.reset_current(self.token)
        self.dir.cleanup()

    def eleven(self, **options):
        server = MockServer(eleven_routes(**options))
        self.servers.append(server)
        elevenlabs_voice.BASE = server.url
        return server

    def voicebox(self, **options):
        server = MockServer(voicebox_routes(**options))
        self.servers.append(server)
        return server


class KeyTests(EngineCase):
    def test_keys_are_sealed_per_account_and_never_stored_plain(self):
        voice_keys.set_key("elevenlabs", f"  {EL_KEY}\n")
        self.assertEqual(voice_keys.get("elevenlabs"), EL_KEY)
        self.assertTrue(voice_keys.has("elevenlabs"))
        self.assertNotIn(EL_KEY, Path(voice_keys.PATH).read_text(encoding="utf-8"))
        with accounts.as_account("other" + os.urandom(2).hex()):
            self.assertEqual(voice_keys.get("elevenlabs"), "", "another account's key cannot unseal this one")
        voice_keys.clear("elevenlabs")
        self.assertFalse(voice_keys.has("elevenlabs"))
        with self.assertRaises(ValueError):
            voice_keys.set_key("elevenlabs", "short")
        with self.assertRaises(ValueError):
            voice_keys.set_key("someone-else", EL_KEY)


class ElevenLabsTests(EngineCase):
    async def test_check_spends_nothing_and_reports_characters_left(self):
        server = self.eleven()
        result = await elevenlabs_voice.check(EL_KEY)
        self.assertEqual(result, {"ok": True, "voices": 3, "characters_left": 8800})
        self.assertEqual([r["path"] for r in server.requests], ["/v2/voices", "/v1/user/subscription"])
        self.assertEqual(server.requests[0]["query"]["page_size"], "1")
        self.assertEqual(server.requests[0]["headers"]["xi-api-key"], EL_KEY)
        self.assertFalse(server.of(f"/v1/text-to-speech/{VOICE}/stream"), "a check renders no speech")

    async def test_a_bad_key_is_said_plainly_without_echoing_it(self):
        self.eleven()
        with self.assertRaises(elevenlabs_voice.ElevenLabsError) as caught:
            await elevenlabs_voice.check("sk_wrong_key_0000000000")
        self.assertIn("did not accept the key", str(caught.exception))
        self.assertNotIn("sk_wrong", str(caught.exception))

    async def test_no_network_is_said_plainly(self):
        elevenlabs_voice.BASE = "http://127.0.0.1:9"
        with self.assertRaisesRegex(elevenlabs_voice.ElevenLabsError, "Could not reach ElevenLabs"):
            await elevenlabs_voice.check(EL_KEY)

    async def test_the_voice_picker_lists_every_page_and_drops_bad_ids(self):
        self.eleven()
        found = await elevenlabs_voice.voices(EL_KEY)
        self.assertEqual([v["id"] for v in found], [VOICE, "MyClone0123456789abc", "AZnzlk1XvdvUeBnXmlld"])
        self.assertEqual(found[1]["name"], "Me (cloned)")

    async def test_a_sentence_streams_as_24k_pcm_in_pieces(self):
        server = self.eleven()
        items = [item async for item in elevenlabs_voice.stream("Hello there.", "eleven_flash_v2_5", VOICE, EL_KEY)]
        self.assertEqual(items[0], {"sample_rate": 24000})
        self.assertEqual(b"".join(i["audio"] for i in items[1:]), PCM)
        self.assertGreater(len(items), 2, "audio arrives in pieces, not one blob")
        request = server.of(f"/v1/text-to-speech/{VOICE}/stream")[0]
        self.assertEqual(request["query"]["output_format"], "pcm_24000")
        self.assertEqual(request["json"], {"text": "Hello there.", "model_id": "eleven_flash_v2_5"})
        self.assertEqual(request["headers"]["xi-api-key"], EL_KEY)
        self.assertNotIn(EL_KEY, json.dumps(request["query"]))

    async def test_an_unknown_model_uses_flash_and_a_bad_voice_sends_nothing(self):
        server = self.eleven()
        _ = [i async for i in elevenlabs_voice.stream("Hi.", "nope", VOICE, EL_KEY)]
        self.assertEqual(server.requests[-1]["json"]["model_id"], "eleven_flash_v2_5")
        before = len(server.requests)
        with self.assertRaises(elevenlabs_voice.ElevenLabsError):
            _ = [i async for i in elevenlabs_voice.stream("Hi.", "eleven_flash_v2_5", "../../x", EL_KEY)]
        self.assertEqual(len(server.requests), before)

    async def test_out_of_credits_is_said_plainly(self):
        self.eleven(out_of_credits=True)
        with self.assertRaisesRegex(elevenlabs_voice.ElevenLabsError, "out of credits"):
            _ = [i async for i in elevenlabs_voice.stream("Hi.", "eleven_flash_v2_5", VOICE, EL_KEY)]

    def test_cost_estimate_uses_the_published_rates(self):
        self.assertEqual(elevenlabs_voice.cost_estimate(1000), 0.04)
        self.assertEqual(elevenlabs_voice.cost_estimate(1000, "eleven_multilingual_v2"), 0.08)


class VoiceboxTests(EngineCase):
    async def test_check_reads_health_and_profiles_and_renders_nothing(self):
        server = self.voicebox()
        self.assertEqual(await voicebox_voice.check(server.url), {"ok": True, "voices": 2})
        self.assertEqual([r["path"] for r in server.requests], ["/health", "/profiles"])

    async def test_something_else_on_the_port_is_not_voicebox(self):
        other = MockServer({("GET", "/health"): lambda r: (200, {}, {"status": "ok"})})
        self.servers.append(other)
        with self.assertRaisesRegex(voicebox_voice.VoiceboxError, "not Voicebox"):
            await voicebox_voice.check(other.url)

    async def test_nothing_running_is_said_plainly(self):
        with self.assertRaisesRegex(voicebox_voice.VoiceboxError, "Could not reach Voicebox"):
            await voicebox_voice.check("http://127.0.0.1:9")

    async def test_catalog_lists_profiles_and_their_engines(self):
        server = self.voicebox()
        found = await voicebox_voice.catalog(server.url)
        self.assertEqual(found["voices"], [{"id": "prof-1", "name": "My voice"}, {"id": "prof-2", "name": "Narrateur"}])
        self.assertEqual(found["models"], ["profile", "chatterbox_turbo", "kokoro"])

    async def test_one_sentence_per_request_handed_out_in_100_ms_pieces(self):
        server = self.voicebox()
        await voicebox_voice.catalog(server.url)
        items = [i async for i in voicebox_voice.stream(server.url, "Bonjour.", "profile", "prof-2")]
        self.assertEqual(items[0], {"sample_rate": 24000})
        self.assertEqual(b"".join(i["audio"] for i in items[1:]), PCM)
        self.assertTrue(all(len(i["audio"]) <= 4800 for i in items[1:]))
        body = server.of("/generate/stream")[0]["json"]
        self.assertEqual(body, {"profile_id": "prof-2", "text": "Bonjour.", "language": "fr"}, "the profile's own engine and language")
        _ = [i async for i in voicebox_voice.stream(server.url, "Hi.", "chatterbox_turbo", "prof-1")]
        self.assertEqual(server.of("/generate/stream")[-1]["json"]["engine"], "chatterbox_turbo")
        self.assertFalse(server.of("/generate"), "nothing is queued into Voicebox's history")

    async def test_float_and_stereo_wav_become_mono_pcm16(self):
        rate, pcm = voicebox_voice.wav_to_pcm16(wav(PCM, rate=48000, channels=2, float32=True))
        self.assertEqual(rate, 48000)
        self.assertEqual(len(pcm), len(PCM))
        rate, pcm = voicebox_voice.wav_to_pcm16(wav(PCM, channels=2))
        self.assertEqual(pcm, PCM)
        with self.assertRaises(voicebox_voice.VoiceboxError):
            voicebox_voice.wav_to_pcm16(b"not audio at all")

    async def test_an_older_voicebox_without_the_stream_route_is_polled(self):
        server = self.voicebox(stream_route=False)
        items = [i async for i in voicebox_voice.stream(server.url, "Hello.", "profile", "prof-1")]
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), PCM)
        self.assertEqual([r["path"] for r in server.requests][-3:], ["/generate", "/generate/gen-1/status", "/audio/gen-1"])

    async def test_a_missing_voice_or_engine_is_said_plainly(self):
        server = self.voicebox()
        with self.assertRaisesRegex(voicebox_voice.VoiceboxError, "voice is gone"):
            _ = [i async for i in voicebox_voice.stream(server.url, "Hi.", "profile", "gone-1")]
        with self.assertRaisesRegex(voicebox_voice.VoiceboxError, "voice and engine"):
            _ = [i async for i in voicebox_voice.stream(server.url, "Hi.", "omnivoice", "prof-1")]
        before = len(server.requests)
        with self.assertRaises(voicebox_voice.VoiceboxError):
            _ = [i async for i in voicebox_voice.stream(server.url, "Hi.", "profile", "../../x")]
        self.assertEqual(len(server.requests), before, "a bad voice id sends nothing")


class EngineChoiceTests(EngineCase):
    async def test_elevenlabs_needs_a_saved_key_then_speaks_for_every_caller(self):
        self.eleven()
        with self.assertRaisesRegex(ValueError, "ElevenLabs key"):
            call_voices.configure("", "elevenlabs")
        voice_keys.set_key("elevenlabs", EL_KEY)
        self.assertEqual(call_voices.configure("", "elevenlabs"), {"choice": "elevenlabs", "url": call_voices.ELEVENLABS_URL, "protocol": "elevenlabs"})
        catalog = await call_voices.catalog()
        self.assertEqual(catalog["models"], ["eleven_flash_v2_5", "eleven_multilingual_v2"])
        self.assertIn(VOICE, [v["id"] for v in catalog["voices"]])
        items = [i async for i in call_voices.pcm("**Hello** there.", "eleven_flash_v2_5", VOICE)]
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), PCM)
        # bots, voice notes and phone calls (LivePipeline.speak, outbound OtherPipeline) all speak through bot_voice
        model, voice = await bot_voice.selection(VOICE)
        self.assertEqual((model, voice), ("eleven_flash_v2_5", VOICE))
        spoken = [i async for i in bot_voice.audio_events("A phone sentence.", VOICE)]
        self.assertEqual(spoken[0], {"sample_rate": 24000})

    async def test_a_voice_from_the_old_engine_speaks_in_the_new_engines_first_voice(self):
        self.eleven()
        voice_keys.set_key("elevenlabs", EL_KEY)
        call_voices.configure("", "elevenlabs")
        self.assertEqual(await bot_voice.selection("af_heart"), ("eleven_flash_v2_5", VOICE))

    async def test_voicebox_as_the_voice_speaks_for_every_caller(self):
        server = self.voicebox()
        call_voices.configure(server.url, "voicebox")
        self.assertEqual(call_voices.choice(), "voicebox")
        catalog = await call_voices.catalog()
        self.assertEqual(catalog["models"][0], "profile")
        items = [i async for i in call_voices.pcm("Hello.", "profile", "prof-1")]
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), PCM)
        self.assertEqual(await bot_voice.selection(None), ("profile", "prof-1"))

    async def test_a_stopped_voicebox_falls_back_to_kokoro(self):
        call_voices.set_choice("voicebox", "http://127.0.0.1:9")
        with patch.object(kokoro_voice, "ready", lambda: (True, None)), \
             patch.object(kokoro_voice, "synthesize", lambda text, voice: b"\x01\x00" * 4800):
            items = [i async for i in call_voices.pcm("Hello.", "profile", "prof-1")]
        self.assertEqual(items[0], {"sample_rate": kokoro_voice.SAMPLE_RATE})

    async def test_a_failing_engine_falls_back_to_kokoro_when_it_is_set_up(self):
        self.eleven(out_of_credits=True)
        voice_keys.set_key("elevenlabs", EL_KEY)
        call_voices.configure("", "elevenlabs")
        with patch.object(kokoro_voice, "ready", lambda: (True, None)), \
             patch.object(kokoro_voice, "synthesize", lambda text, voice: b"\x01\x00" * 4800) as _:
            items = [i async for i in call_voices.pcm("Hello.", "eleven_flash_v2_5", VOICE)]
        self.assertEqual(items[0], {"sample_rate": kokoro_voice.SAMPLE_RATE})
        self.assertEqual(len(b"".join(i.get("audio", b"") for i in items)), 9600)

    async def test_without_kokoro_the_engines_own_reason_goes_up(self):
        self.eleven(out_of_credits=True)
        voice_keys.set_key("elevenlabs", EL_KEY)
        call_voices.configure("", "elevenlabs")
        with self.assertRaisesRegex(ValueError, "out of credits"):
            _ = [i async for i in call_voices.pcm("Hello.", "eleven_flash_v2_5", VOICE)]

    async def test_voicebox_refuses_remote_addresses_and_defaults_to_its_port(self):
        for url in ("https://voicebox.example.com:17493", "http://192.168.1.5:17493", "http://127.0.0.1:17493/admin"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                call_voices.configure(url, "voicebox")
        self.assertEqual(call_voices.configure("", "voicebox")["url"], "http://127.0.0.1:17493")
        with self.assertRaises(ValueError):
            call_voices.configure("http://127.0.0.1:3900", "voicestudio")

    async def test_kairos_voice_is_kokoro_when_ready_else_the_device_voice(self):
        self.assertEqual(call_voices.choice(), "kairos", "Kairos Voice is the default")
        self.assertEqual(call_voices.configuration(), {"choice": "kairos", "url": "", "protocol": "kokoro"})
        catalog = await call_voices.catalog()
        self.assertIn("device voice", catalog["error"])
        with patch.object(kokoro_voice, "ready", lambda: (True, None)):
            self.assertEqual(call_voices.configuration()["url"], call_voices.KOKORO_URL)
            call_voices.set_choice("gpt_live")
            self.assertEqual(call_voices.configuration()["protocol"], "kokoro", "with GPT-Live, things read aloud use Kairos Voice")


class MigrationTests(EngineCase):
    def old(self, value):
        write_json_atomic(call_voices.SETTINGS, value)

    def test_a_saved_voicestudio_becomes_kairos_voice_with_a_notice(self):
        voice_keys.set_key("elevenlabs", EL_KEY)
        data = read_json(voice_keys.PATH, {}); data["voicestudio"] = "sealed-old-key"; write_json_atomic(voice_keys.PATH, data)
        self.old({"url": "http://127.0.0.1:3900", "protocol": "voicestudio"})
        saved = call_voices.stored()
        self.assertEqual((saved["choice"], saved["notice"]), ("kairos", call_voices.VOICESTUDIO_NOTICE))
        self.assertNotIn("voicestudio", read_json(voice_keys.PATH, {}), "its old key is removed")
        self.assertTrue(voice_keys.has("elevenlabs"), "other keys stay")
        self.assertEqual(read_json(call_voices.SETTINGS, {})["version"], 2, "migrated once, on disk")
        call_voices.dismiss_notice()
        self.assertEqual(call_voices.stored()["notice"], "")

    def test_the_old_empty_default_is_kairos_voice_without_a_notice(self):
        self.old({"url": "", "protocol": "voicestudio"})
        self.assertEqual((call_voices.choice(), call_voices.stored()["notice"]), ("kairos", ""))

    def test_every_engine_that_still_exists_is_kept(self):
        voice_keys.set_key("elevenlabs", EL_KEY)
        for old, choice in (({"url": call_voices.ELEVENLABS_URL, "protocol": "elevenlabs"}, "elevenlabs"),
                            ({"url": call_voices.KOKORO_URL, "protocol": "kokoro"}, "kairos"),
                            ({"url": "http://127.0.0.1:8880", "protocol": "compatible"}, "compatible")):
            with self.subTest(old=old):
                self.old(old)
                self.assertEqual(call_voices.choice(), choice)
                if choice == "compatible":
                    self.assertEqual(call_voices.configuration()["url"], "http://127.0.0.1:8880")

    def test_elevenlabs_without_its_key_is_kairos_voice(self):
        self.old({"url": call_voices.ELEVENLABS_URL, "protocol": "elevenlabs"})
        self.assertEqual(call_voices.choice(), "kairos")


class CompatibleTests(EngineCase):
    async def test_a_server_without_a_voice_list_uses_typed_voice_names(self):
        # Voicebox's own OpenAI-compatible router has /v1/models and /v1/audio/speech but no /v1/audio/voices.
        server = MockServer({("GET", "/v1/models"): lambda r: (200, {}, {"data": [{"id": "voicebox"}]}),
                             ("POST", "/v1/audio/speech"): lambda r: (200, {"Content-Type": "audio/pcm"}, chunks(PCM))})
        self.servers.append(server)
        call_voices.set_choice("compatible", server.url)
        catalog = await call_voices.catalog()
        self.assertEqual((catalog["voices"], catalog["models"]), ([], ["voicebox"]))
        self.assertIn("Type a voice name", catalog["error"])
        call_voices.set_compatible_voices(["My voice", " ", "Narrator"])
        catalog = await call_voices.catalog()
        self.assertEqual([v["id"] for v in catalog["voices"]], ["My voice", "Narrator"])
        self.assertNotIn("error", catalog)
        items = [i async for i in call_voices.pcm("Hello.", "voicebox", "My voice")]
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), PCM)


class RouteTests(EngineCase):
    def app(self, admin=True):
        app = FastAPI()
        app.include_router(voice_engine_routes.router)
        app.dependency_overrides[require_user] = lambda: "david"
        if admin:
            app.dependency_overrides[require_admin] = lambda: "david"
        else:
            def denied():
                from fastapi import HTTPException
                raise HTTPException(403, "admin privileges required")
            app.dependency_overrides[require_admin] = denied
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_a_bad_key_is_not_saved_and_a_good_one_is_saved_sealed_and_used(self):
        self.eleven()
        async with self.app() as client:
            bad = await client.put("/api/voice-engines/elevenlabs", json={"api_key": "sk_wrong_key_0000000000"})
            self.assertEqual(bad.status_code, 422)
            self.assertFalse(voice_keys.has("elevenlabs"))
            good = await client.put("/api/voice-engines/elevenlabs", json={"api_key": EL_KEY})
            self.assertEqual(good.status_code, 200)
            self.assertEqual(good.json()["choice"], "elevenlabs")
            self.assertEqual(good.json()["check"]["characters_left"], 8800)
            state = (await client.get("/api/voice-engines")).json()
            self.assertTrue(state["elevenlabs"]["has_key"])
            self.assertNotIn(EL_KEY, json.dumps(state) + good.text)
            checked = await client.post("/api/voice-engines/elevenlabs/check", json={})
            self.assertEqual(checked.json()["voices"], 3)
            gone = (await client.delete("/api/voice-engines/elevenlabs")).json()
            self.assertFalse(gone["elevenlabs"]["has_key"])
            self.assertEqual(gone["choice"], "kairos", "no key, no ElevenLabs: Kairos Voice speaks again")

    async def test_voicebox_is_for_an_admin_on_this_computer(self):
        server = self.voicebox()
        async with self.app(admin=False) as client:
            self.assertEqual((await client.put("/api/voice-engines/voicebox", json={"url": server.url})).status_code, 403)
            self.assertEqual((await client.put("/api/voice-engines/choice", json={"choice": "voicebox"})).status_code, 403)
        async with self.app() as client:
            checked = await client.post("/api/voice-engines/voicebox/check", json={"url": server.url})
            self.assertEqual(checked.json(), {"ok": True, "voices": 2})
            saved = await client.put("/api/voice-engines/voicebox", json={"url": server.url})
            self.assertEqual((saved.json()["choice"], saved.json()["voicebox"]["url"]), ("voicebox", server.url))
            remote = await client.put("/api/voice-engines/voicebox", json={"url": "http://10.0.0.7:17493"})
            self.assertEqual(remote.status_code, 422)

    async def test_the_choice_needs_what_each_option_needs(self):
        async with self.app() as client:
            state = (await client.get("/api/voice-engines")).json()
            self.assertEqual(state["choice"], "kairos")
            self.assertEqual((await client.put("/api/voice-engines/choice", json={"choice": "elevenlabs"})).status_code, 422)
            self.assertEqual((await client.put("/api/voice-engines/choice", json={"choice": "gpt_live"})).json()["detail"], "Add your OpenAI key first.")
            self.assertEqual((await client.put("/api/voice-engines/choice", json={"choice": "voicestudio"})).status_code, 422)
            with patch.object(voice_engine_routes, "_gpt_live", lambda: {"id": "live:x", "provider": "openai_live"}):
                chosen = (await client.put("/api/voice-engines/choice", json={"choice": "gpt_live"})).json()
            self.assertEqual((chosen["choice"], chosen["gpt_live"]["available"]), ("gpt_live", True))
            back = (await client.put("/api/voice-engines/choice", json={"choice": "kairos"})).json()
            self.assertEqual(back["choice"], "kairos")

    async def test_gpt_live_in_one_step_checks_the_openai_key_and_never_shows_it(self):
        made = []
        seen = []

        def handler(request):
            seen.append(request)
            if request.headers.get("authorization") != f"Bearer {OPENAI_KEY}":
                return httpx.Response(401, json={"error": {"message": "Incorrect API key"}})
            return httpx.Response(200, json={"data": [{"id": "gpt-4.1-mini"}, {"id": "gpt-realtime"}]})
        live = {"value": None}
        with patch.object(openai_key, "TRANSPORT", httpx.MockTransport(handler)), \
             patch.object(openai_key, "current", lambda: None), \
             patch.object(openai_key.model_endpoints, "create_endpoint", lambda *a: made.append(a) or live.update(value={"id": "live:e1", "provider": "openai_live"}) or {"id": "e1"}), \
             patch.object(voice_engine_routes, "_gpt_live", lambda: live["value"]):
            async with self.app() as client:
                bad = await client.put("/api/voice-engines/openai", json={"api_key": "sk-wrong-key-000000000000000"})
                self.assertEqual(bad.status_code, 422)
                self.assertIn("did not accept", bad.json()["detail"])
                self.assertEqual(made, [], "a key that does not work is not saved")
                good = await client.put("/api/voice-engines/openai", json={"api_key": OPENAI_KEY})
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json()["choice"], "gpt_live")
        self.assertEqual(made[0][:3], ("OpenAI", "https://api.openai.com/v1", "gpt-4.1-mini"))
        self.assertEqual(str(seen[-1].url), "https://api.openai.com/v1/models", "the check only lists models")
        self.assertNotIn(OPENAI_KEY, good.text)


if __name__ == "__main__":
    unittest.main()
