"""ElevenLabs and VoiceStudio as voice engines, against MOCK servers on 127.0.0.1 only (a small HTTP server per test that
speaks just enough of each API, streaming its audio in chunks). Nothing reaches ElevenLabs or any real VoiceStudio.

Proves our side: keys sealed per account and never shown, the documented request shapes (ElevenLabs' streaming
text-to-speech with xi-api-key and pcm_24000; VoiceStudio's OpenAI-compatible speech route with a Bearer key), "Check"
spending nothing, voice pickers from the account or install, the Kokoro fallback when the engine fails, and that bots,
voice notes and phone calls (to the person and to others) speak through the chosen engine.
Run: python scripts/test_voice_engines.py
"""
import asyncio
import json
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

from core import accounts, call_voices, elevenlabs_voice, kokoro_voice, voice_keys, voicestudio_voice  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import voice_engine_routes  # noqa: E402
from services import bot_voice  # noqa: E402

EL_KEY = "sk_test_ELEVEN_secret_0123456789abcdef"
VS_KEY = "vs-test-OMNIVOICE-secret-0123456789"
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


def studio_routes(key=None, engines=None):
    def authed(request):
        return key is None or request["headers"].get("authorization") == f"Bearer {key}"

    def guard(handler):
        return lambda request: handler(request) if authed(request) else (401, {}, {"detail": "API key required"})

    voices = {"voices": [{"voice_id": "alloy", "id": "alloy", "name": "alloy", "type": "openai_alias"},
                         {"voice_id": "prof_1", "id": "prof_1", "name": "My voice", "type": "profile"}]}
    if engines is not None:
        voices["engines"] = engines
    return {("GET", "/health"): lambda r: (200, {}, {"status": "ok"}),
            ("GET", "/v1/audio/voices"): guard(lambda r: (200, {}, voices)),
            ("GET", "/v1/models"): guard(lambda r: (200, {}, {"data": [{"id": "tts-1"}, {"id": "gpt-4o-mini-tts-2025"}, {"id": "omnivoice"},
                                                                       {"id": "pockettts"}, {"id": "faster-whisper"}]})),
            ("POST", "/v1/audio/speech"): guard(lambda r: (200, {"Content-Type": "audio/pcm"}, chunks(PCM)))}


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

    def studio(self, **options):
        server = MockServer(studio_routes(**options))
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


class VoiceStudioTests(EngineCase):
    async def test_check_reads_health_and_voices_and_renders_nothing(self):
        server = self.studio()
        result = await voicestudio_voice.check(server.url, "")
        self.assertEqual(result["voices"], 1)
        self.assertEqual(result["engines"], ["tts-1", "omnivoice", "pockettts"])
        self.assertEqual(server.of("/v1/audio/speech"), [])
        self.assertNotIn("authorization", server.requests[0]["headers"], "loopback needs no key")

    async def test_a_keyed_voicestudio_gets_the_bearer_key_and_says_when_it_is_missing(self):
        server = self.studio(key=VS_KEY)
        with self.assertRaisesRegex(voicestudio_voice.VoiceStudioError, "OMNIVOICE_API_KEY"):
            await voicestudio_voice.check(server.url, "")
        await voicestudio_voice.check(server.url, VS_KEY)
        self.assertEqual(server.of("/v1/audio/voices")[-1]["headers"]["authorization"], f"Bearer {VS_KEY}")

    async def test_nothing_running_is_said_plainly(self):
        with self.assertRaisesRegex(voicestudio_voice.VoiceStudioError, "Could not reach VoiceStudio"):
            await voicestudio_voice.check("http://127.0.0.1:9", "")

    async def test_the_speech_route_streams_pcm_with_the_documented_fields(self):
        server = self.studio(key=VS_KEY)
        items = [i async for i in voicestudio_voice.stream(server.url, VS_KEY, "Hello.", "omnivoice", "prof_1")]
        self.assertEqual(items[0], {"sample_rate": 24000})
        self.assertEqual(b"".join(i["audio"] for i in items[1:]), PCM)
        body = server.of("/v1/audio/speech")[0]["json"]
        self.assertEqual(body, {"model": "omnivoice", "voice": "prof_1", "input": "Hello.", "response_format": "pcm", "stream_format": "audio"})

    async def test_catalog_hides_openai_aliases_and_prefers_its_engine_list(self):
        server = self.studio(engines=[{"id": "pockettts", "available": True}, {"id": "omnivoice", "available": False}])
        found = await voicestudio_voice.catalog(server.url, "")
        self.assertEqual(found["models"], ["tts-1", "pockettts"])
        self.assertEqual([v["id"] for v in found["voices"]], ["default", "prof_1"])


class EngineChoiceTests(EngineCase):
    async def test_elevenlabs_needs_a_saved_key_then_speaks_for_every_caller(self):
        self.eleven()
        with self.assertRaisesRegex(ValueError, "ElevenLabs key"):
            call_voices.configure("", "elevenlabs")
        voice_keys.set_key("elevenlabs", EL_KEY)
        self.assertEqual(call_voices.configure("", "elevenlabs"), {"url": call_voices.ELEVENLABS_URL, "protocol": "elevenlabs"})
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

    async def test_voicestudio_keeps_its_key_and_speaks(self):
        server = self.studio(key=VS_KEY)
        voice_keys.set_key("voicestudio", VS_KEY)
        call_voices.configure(server.url, "voicestudio")
        catalog = await call_voices.catalog()
        self.assertEqual(catalog["models"][0], "tts-1")
        items = [i async for i in call_voices.pcm("Hello.", "tts-1", "default")]
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), PCM)

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

    async def test_voicestudio_still_refuses_remote_addresses(self):
        for url in ("https://voicestudio.example.com:3900", "http://192.168.1.5:3900", "http://127.0.0.1:3900/admin"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                call_voices.configure(url, "voicestudio")
        self.assertEqual(call_voices.configure("", "voicestudio")["url"], "http://127.0.0.1:3900")


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
            self.assertEqual(good.json()["active"], "elevenlabs")
            self.assertEqual(good.json()["check"]["characters_left"], 8800)
            state = (await client.get("/api/voice-engines")).json()
            self.assertTrue(state["elevenlabs"]["has_key"])
            self.assertNotIn(EL_KEY, json.dumps(state) + good.text)
            checked = await client.post("/api/voice-engines/elevenlabs/check", json={})
            self.assertEqual(checked.json()["voices"], 3)
            gone = (await client.delete("/api/voice-engines/elevenlabs")).json()
            self.assertFalse(gone["elevenlabs"]["has_key"])
            self.assertEqual(gone["active"], "", "no key, no ElevenLabs: the device voice is used")

    async def test_voicestudio_is_for_an_admin_and_its_key_is_never_shown(self):
        server = self.studio(key=VS_KEY)
        async with self.app(admin=False) as client:
            self.assertEqual((await client.put("/api/voice-engines/voicestudio", json={"url": server.url})).status_code, 403)
            self.assertEqual((await client.post("/api/voice-engines/use", json={"engine": "voicestudio"})).status_code, 403)
        async with self.app() as client:
            missing = await client.post("/api/voice-engines/voicestudio/check", json={"url": server.url})
            self.assertEqual(missing.status_code, 422)
            self.assertIn("OMNIVOICE_API_KEY", missing.json()["detail"])
            saved = await client.put("/api/voice-engines/voicestudio", json={"url": server.url, "api_key": VS_KEY})
            self.assertEqual(saved.status_code, 200)
            self.assertEqual((saved.json()["active"], saved.json()["voicestudio"]["url"]), ("voicestudio", server.url))
            self.assertNotIn(VS_KEY, saved.text)
            remote = await client.put("/api/voice-engines/voicestudio", json={"url": "http://10.0.0.7:3900"})
            self.assertEqual(remote.status_code, 422)


if __name__ == "__main__":
    unittest.main()
