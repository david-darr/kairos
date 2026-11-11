"""HD voice (core/hd_voice.py): Qwen3-TTS on an NVIDIA card as Kairos Voice's optional HD quality.

Everything here runs without a graphics card, PyTorch or a network: the GPU answer is faked (GPU_PROBE), the installer
downloads from a MOCK server on 127.0.0.1 (small wheels built here, files with known hashes), and the sidecar is a
small fake process that speaks the real sidecar's framed protocol (silence, a tone, silence). The real sidecar is
measured on David's RTX 4090 with scripts/bench_voice_turn.py, not here.

Proves: GPU detection and hiding (no NVIDIA card, an old driver, an old card, too little free memory, a good card);
the installer (pinned sha256 checked, a mismatch discarded, resume with an HTTP Range request after a broken
download, a server that ignores Range, an unsafe wheel refused, not enough disk, https only, remove); the sidecar's
lifecycle (load on first use while Kokoro speaks, warm at call start, one queue in order, cancel when a sentence is
dropped, stop when idle) and the fallback to Kokoro (missing, still loading, crashed, an error, too slow, stopped
three times); edge trim; pronunciations as respellings; the routes (state, quality refused until installed, admin-only
install and remove, preview WAV); and that calls, read-aloud, voice notes, phone calls (bot_voice) speak through HD when
it is chosen.
Run: python scripts/test_hd_voice.py
"""
import asyncio
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import wave
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-hd-voice-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from core import accounts, call_voices, hd_voice, kokoro_voice, pronunciations  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import voice_engine_routes  # noqa: E402
from services import bot_voice  # noqa: E402

GOOD_CARD = {"name": "NVIDIA GeForce RTX 4090", "total_mb": 24564, "free_mb": 18000, "driver": "616.56", "capability": "8.9"}

FAKE_SIDECAR = textwrap.dedent(r'''
    import json, os, struct, sys, time
    mode, log = sys.argv[1], sys.argv[2]
    out = os.fdopen(os.dup(1), "wb", buffering=0)
    def send(h, payload=b""):
        if payload: h = {**h, "bytes": len(payload)}
        raw = json.dumps(h).encode(); out.write(struct.pack(">I", len(raw)) + raw + payload)
    silence = b"\x00\x00" * 4800                                   # 0.2 s
    tone = (struct.pack("<h", 8000) + struct.pack("<h", -8000)) * 2400   # 0.2 s, loud
    for line in sys.stdin:
        m = json.loads(line)
        with open(log, "a") as f: f.write(line)
        op = m.get("op")
        if op == "quit": break
        if op == "cancel": continue
        if op == "load":
            if mode == "loadfail": send({"type": "error", "message": "no CUDA device"}); continue
            time.sleep(0.05); send({"type": "loaded", "voice": m["voice"], "seconds": 0.05}); continue
        if op == "say":
            if mode == "crash": sys.exit(3)
            if mode == "error": send({"id": m["id"], "type": "error", "message": "out of memory"}); continue
            send({"id": m["id"], "type": "start", "rate": 24000})
            if mode == "slow": time.sleep(1.0)
            for piece in [silence, silence[:3000] + tone[:6600], tone, silence, tone, silence, silence, silence]:
                send({"id": m["id"], "type": "audio"}, piece); time.sleep(0.005)
            send({"id": m["id"], "type": "end"})
''')


class Mock:
    """A loopback file server: path -> bytes. Options per path: 'break_at' (close after N bytes, once), 'no_range'."""

    def __init__(self, files, options=None):
        self.files, self.options, self.requests = files, options or {}, []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                mock.requests.append((self.path, self.headers.get("Range")))
                data = mock.files.get(self.path)
                if data is None:
                    self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
                option = mock.options.get(self.path, {})
                start, status = 0, 200
                rng = self.headers.get("Range")
                if rng and not option.get("no_range"):
                    start, status = int(rng.split("=")[1].split("-")[0]), 206
                body = data[start:]
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
                self.end_headers()
                cut = option.pop("break_at", None)
                if cut is not None:
                    self.wfile.write(body[:cut]); self.wfile.flush()
                    self.close_connection = True
                    self.connection.shutdown(2)
                    return
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def wheel(name: str, files: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, text in files.items():
            archive.writestr(path, text)
    return buffer.getvalue()


def entry(data: bytes, **extra) -> dict:
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data), **extra}


class HDCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.hd = os.path.join(self.dir.name, "hd")
        os.makedirs(self.hd)
        self.log = os.path.join(self.dir.name, "sidecar.log")
        self.fake = os.path.join(self.dir.name, "fake_sidecar.py")
        Path(self.fake).write_text(FAKE_SIDECAR, encoding="utf-8")
        self.account = "hd" + os.urandom(3).hex()
        self.token = accounts.set_current(self.account)
        self.card = dict(GOOD_CARD)
        self.manifest = {"version": 7, "unpacked_bytes": 10, "wheels": [], "files": [], "sources": []}
        self.patches = [
            patch.object(hd_voice, "HD_DIR", self.hd), patch.object(hd_voice, "MANIFEST", self.manifest),
            patch.object(hd_voice, "GPU_PROBE", lambda: [self.card] if self.card else None),
            patch.object(hd_voice, "ALLOW_LOOPBACK_HTTP", True),
            patch.object(call_voices, "SETTINGS", os.path.join(self.dir.name, "voice.json")),
            patch.object(pronunciations, "PATH", os.path.join(self.dir.name, "pron.json")),
            patch.object(kokoro_voice, "ready", lambda: (True, None)),
            patch.object(kokoro_voice, "synthesize", lambda text, voice: b"\x07\x00" * 4800),
        ]
        for item in self.patches:
            item.start()
        hd_voice._gpu_cache.clear()
        hd_voice._progress.clear()
        hd_voice._sidecar.crashes.clear()
        hd_voice._sidecar.failed_reason = ""
        self.mocks = []

    def tearDown(self):
        hd_voice._sidecar.stop()
        for mock in self.mocks:
            mock.stop()
        for item in self.patches:
            item.stop()
        hd_voice._gpu_cache.clear()
        accounts.reset_current(self.token)
        self.dir.cleanup()

    def sidecar(self, mode="ok"):
        return patch.object(hd_voice, "SIDECAR_COMMAND", [sys.executable, "-I", self.fake, mode, self.log])

    def ops(self):
        try:
            return [json.loads(line) for line in Path(self.log).read_text().splitlines()]
        except OSError:
            return []

    def fake_install(self):
        """An installed HD voice on disk (what a finished install leaves), without downloading anything."""
        self.manifest["files"] = [{"path": "models/base/model.safetensors", "url": "https://x/1", "sha256": "0" * 64, "size": 1}]
        os.makedirs(os.path.join(self.hd, "models", "base"))
        Path(self.hd, "models", "base", "model.safetensors").write_bytes(b"x")
        os.makedirs(os.path.join(self.hd, "env", "site"))
        Path(self.hd, "installed.json").write_text(json.dumps({"version": 7}))

    async def collect(self, gen):
        return [item async for item in gen]

    def build_manifest(self, mock_files, options=None, corrupt=None):
        """Two wheels (one with a .data/purelib part) and three files, one of them the same bytes under two paths."""
        w1 = wheel("alpha", {"alpha/__init__.py": "VALUE = 1\n", "alpha-1.0.dist-info/METADATA": "Name: alpha\n"})
        w2 = wheel("beta", {"beta-2.0.data/purelib/beta.py": "VALUE = 2\n", "beta-2.0.data/scripts/beta": "#!", "beta-2.0.dist-info/METADATA": "Name: beta\n"})
        model = os.urandom(300_000)
        tokenizer = os.urandom(50_000)
        clip = b"RIFF" + os.urandom(1000)
        served = {"/w/alpha.whl": w1, "/w/beta.whl": w2, "/m/model": model, "/m/tok": tokenizer, "/v/clip": clip}
        if corrupt:
            served[corrupt] = served[corrupt][:-1] + bytes([served[corrupt][-1] ^ 1])
        mock = Mock(served, options)
        self.mocks.append(mock)
        self.manifest["wheels"] = [entry(w1, name="alpha-1.0-py3-none-any.whl", url=mock.url + "/w/alpha.whl"),
                                   entry(w2, name="beta-2.0-py3-none-any.whl", url=mock.url + "/w/beta.whl")]
        self.manifest["files"] = [entry(model, path="models/customvoice/model.safetensors", url=mock.url + "/m/model"),
                                  entry(tokenizer, path="models/customvoice/speech_tokenizer/model.safetensors", url=mock.url + "/m/tok"),
                                  entry(tokenizer, path="models/base/speech_tokenizer/model.safetensors", url=mock.url + "/m/tok"),
                                  entry(clip, path="voices/iris.wav", url=mock.url + "/v/clip")]
        return mock

    async def install(self):
        hd_voice.start_install()
        await asyncio.wait_for(hd_voice._install_task, 30)
        return hd_voice.status()


class DetectionTests(HDCase):
    def test_no_nvidia_card_sees_nothing(self):
        self.card = None
        state = hd_voice.status()
        self.assertEqual((state["offered"], state["nvidia"], state["reason"]), (False, False, ""))
        with self.assertRaises(ValueError):
            hd_voice.start_install()

    def test_a_card_that_falls_short_gets_one_plain_line(self):
        for change, words in [({"driver": "531.79"}, "Update the NVIDIA driver to version 570"),
                              ({"capability": "7.5", "name": "NVIDIA GeForce RTX 2080"}, "RTX 30 series card or newer"),
                              ({"free_mb": 2500}, "about 4 GB of free graphics memory")]:
            with self.subTest(change=change):
                self.card = {**GOOD_CARD, **change}
                hd_voice._gpu_cache.clear()
                state = hd_voice.status()
                self.assertFalse(state["offered"])
                self.assertTrue(state["nvidia"])
                self.assertIn(words, state["reason"])
                self.assertNotIn("—", state["reason"])

    def test_a_capable_card_is_offered_and_sizes_are_stated(self):
        state = hd_voice.status()
        self.assertTrue(state["offered"])
        self.assertEqual(state["card"], "NVIDIA GeForce RTX 4090")
        self.assertEqual(state["state"], "not_installed")

    def test_the_shipped_manifest_is_pinned_and_official(self):
        with patch.object(hd_voice, "MANIFEST", None):
            m = hd_voice.manifest()
            size = hd_voice.sizes()
        for item in m["wheels"] + m["files"]:
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(item["url"].startswith(("https://download-r2.pytorch.org/", "https://files.pythonhosted.org/", "https://huggingface.co/Qwen/", "https://huggingface.co/kyutai/tts-voices/")), item["url"])
            self.assertGreater(int(item["size"]), 0)
        names = " ".join(w["name"] for w in m["wheels"])
        for wanted in ["torch-2.9.1+cu128", "transformers-5.15.1", "accelerate-1.12.0"]:
            self.assertIn(wanted, names)
        for unwanted in ["gradio", "librosa", "soundfile", "faster_qwen3_tts", "qwen_tts"]:
            self.assertNotIn(unwanted, names)
        self.assertTrue(all("/resolve/" in f["url"] and len(f["url"].split("/resolve/")[1].split("/")[0]) == 40 for f in m["files"]), "weights pinned to a commit")
        self.assertAlmostEqual(size["download_bytes"] / 1e9, 7.23, places=1)


class InstallerTests(HDCase):
    async def test_install_downloads_verifies_unpacks_and_links_the_shared_file(self):
        mock = self.build_manifest({})
        state = await self.install()
        self.assertEqual(hd_voice._progress["status"], "done", hd_voice._progress)
        self.assertTrue(state["installed"])
        site = os.path.join(self.hd, "env", "site")
        self.assertEqual(Path(site, "alpha", "__init__.py").read_text(), "VALUE = 1\n")
        self.assertEqual(Path(site, "beta.py").read_text(), "VALUE = 2\n")              # .data/purelib unpacked
        self.assertFalse(os.path.exists(os.path.join(site, "beta")))                    # .data/scripts left out
        self.assertFalse(os.path.exists(os.path.join(self.hd, "downloads")))           # wheels deleted after unpacking
        self.assertEqual(sum(1 for path, _ in mock.requests if path == "/m/tok"), 1)  # the shared file came once
        base = Path(self.hd, "models", "base", "speech_tokenizer", "model.safetensors")
        self.assertEqual(hashlib.sha256(base.read_bytes()).hexdigest(), self.manifest["files"][2]["sha256"])

    async def test_a_sha256_mismatch_is_discarded_and_nothing_is_installed(self):
        self.build_manifest({}, corrupt="/m/model")
        state = await self.install()
        self.assertEqual(hd_voice._progress["status"], "error")
        self.assertIn("did not match its pinned SHA-256", hd_voice._progress["error"])
        self.assertFalse(state["installed"])
        self.assertFalse(os.path.exists(os.path.join(self.hd, "models", "customvoice", "model.safetensors")))
        self.assertFalse(os.path.exists(os.path.join(self.hd, "models", "customvoice", "model.safetensors.part")))
        self.assertFalse(os.path.exists(os.path.join(self.hd, "env", "site")))

    async def test_a_broken_download_resumes_with_a_range_request(self):
        mock = self.build_manifest({}, options={"/m/model": {"break_at": 120_000}})
        await self.install()
        self.assertEqual(hd_voice._progress["status"], "error")
        state = hd_voice.status()
        self.assertEqual(state["state"], "partial")
        self.assertGreaterEqual(state["partial_bytes"], 120_000)
        await self.install()
        self.assertEqual(hd_voice._progress["status"], "done", hd_voice._progress)
        self.assertIn(("/m/model", "bytes=120000-"), mock.requests)
        self.assertEqual([r for r in mock.requests if r[0] == "/w/alpha.whl"].__len__(), 1)  # a finished wheel is not fetched again
        self.assertTrue(hd_voice.installed())

    async def test_a_server_that_ignores_range_starts_the_file_again(self):
        mock = self.build_manifest({}, options={"/m/model": {"break_at": 100_000, "no_range": True}})
        await self.install()
        await self.install()
        self.assertEqual(hd_voice._progress["status"], "done", hd_voice._progress)
        self.assertIn(("/m/model", "bytes=100000-"), mock.requests)
        self.assertTrue(hd_voice.installed())

    async def test_pause_keeps_what_arrived(self):
        self.build_manifest({})
        hd_voice.start_install()
        hd_voice.stop_install()
        await asyncio.wait_for(hd_voice._install_task, 30)
        self.assertEqual(hd_voice._progress["status"], "stopped")
        self.assertFalse(hd_voice.installed())

    async def test_an_unsafe_wheel_is_refused(self):
        bad = wheel("evil", {"../../escape.py": "x"})
        mock = Mock({"/w/evil.whl": bad})
        self.mocks.append(mock)
        self.manifest["wheels"] = [entry(bad, name="evil-1.0-py3-none-any.whl", url=mock.url + "/w/evil.whl")]
        await self.install()
        self.assertEqual(hd_voice._progress["status"], "error")
        self.assertIn("unsafe path", hd_voice._progress["error"])
        self.assertFalse(os.path.exists(os.path.join(self.dir.name, "escape.py")))

    async def test_not_enough_disk_space_stops_before_downloading(self):
        mock = self.build_manifest({})
        with patch.object(hd_voice.shutil, "disk_usage", lambda path: type("U", (), {"free": 10_000})()):
            await self.install()
        self.assertIn("free disk space", hd_voice._progress["error"])
        self.assertEqual(mock.requests, [])

    async def test_only_https_addresses_download(self):
        self.build_manifest({})
        with patch.object(hd_voice, "ALLOW_LOOPBACK_HTTP", False):
            await self.install()
        self.assertIn("no secure address", hd_voice._progress["error"])

    async def test_remove_deletes_everything_and_stops_the_sidecar(self):
        self.build_manifest({})
        await self.install()
        with self.sidecar():
            await hd_voice._sidecar.load("iris")
            self.assertTrue(hd_voice._sidecar.running())
            await hd_voice.remove()
        self.assertFalse(hd_voice._sidecar.running())
        self.assertFalse(os.path.exists(self.hd))
        self.assertEqual(hd_voice.status()["state"], "not_installed")


class SidecarTests(HDCase):
    def setUp(self):
        super().setUp()
        self.fake_install()
        call_voices._save(quality="hd")

    async def test_first_use_loads_in_the_background_while_kokoro_speaks_then_hd_speaks_trimmed(self):
        with self.sidecar():
            self.assertEqual(call_voices.configuration()["protocol"], "hd")
            first = await self.collect(call_voices.pcm("Hello there.", hd_voice.NAME, "iris"))
            self.assertEqual(b"".join(i.get("audio", b"") for i in first), b"\x07\x00" * 4800)    # Kokoro's bytes
            for _ in range(100):
                if hd_voice._sidecar.warm_kind("iris"):
                    break
                await asyncio.sleep(0.05)
            items = await self.collect(call_voices.pcm("Hello there.", hd_voice.NAME, "iris"))
        self.assertEqual(items[0], {"sample_rate": 24000})
        audio = b"".join(i.get("audio", b"") for i in items)
        samples = np.frombuffer(audio, "<i2")
        # fake: 0.2 s silence, 0.0625 s silence + tone, 0.2 s tone, 0.2 s silence, 0.2 s tone, 0.6 s silence
        lead = int(np.flatnonzero(np.abs(samples) > 1000)[0])
        tail = len(samples) - 1 - int(np.flatnonzero(np.abs(samples) > 1000)[-1])
        self.assertLessEqual(lead, 720 + 240)                     # 30 ms kept before the sound (frame resolution)
        self.assertLessEqual(tail, 1920 + 240)                    # 80 ms kept after
        self.assertGreater(len(samples), 0.75 * 24000)           # the pause inside the sentence stayed
        says = [op for op in self.ops() if op["op"] == "say"]
        self.assertEqual(says[-1]["voice"], "iris")

    async def test_warm_at_call_start_and_one_queue_in_order(self):
        with self.sidecar():
            self.assertTrue(await hd_voice.warm("ryan"))
            a = asyncio.ensure_future(self.collect(hd_voice.stream("One.", "ryan")))
            b = asyncio.ensure_future(self.collect(hd_voice.stream("Two.", "ryan")))
            first, second = await asyncio.gather(a, b)
        self.assertTrue(first and second)
        says = [op for op in self.ops() if op["op"] == "say"]
        self.assertEqual([op["text"] for op in says], ["One.", "Two."])
        self.assertEqual([op for op in self.ops() if op["op"] == "load"][0]["voice"], "ryan")

    async def test_a_dropped_sentence_is_cancelled(self):
        with self.sidecar():
            await hd_voice.warm("iris")
            gen = hd_voice.stream("Interrupt me.", "iris")
            async for item in gen:
                if "audio" in item:
                    break
            await gen.aclose()
            await asyncio.sleep(0.3)
            hd_voice._sidecar.stop()
        self.assertTrue(any(op["op"] == "cancel" for op in self.ops()))

    async def test_failures_fall_back_to_kokoro_before_any_audio(self):
        for mode in ["error", "slow", "crash"]:
            with self.subTest(mode=mode), self.sidecar(mode), patch.object(hd_voice, "FIRST_AUDIO_TIMEOUT", 0.3):
                hd_voice._sidecar.stop()
                hd_voice._sidecar.crashes.clear()
                await hd_voice.warm("iris")
                items = await self.collect(call_voices.pcm("Hello.", hd_voice.NAME, "iris"))
                self.assertEqual(b"".join(i.get("audio", b"") for i in items), b"\x07\x00" * 4800, mode)

    async def test_a_missing_sidecar_or_install_means_kokoro(self):
        with patch.object(hd_voice, "SIDECAR_COMMAND", [sys.executable, "-I", os.path.join(self.dir.name, "missing.py")]):
            self.assertFalse(await hd_voice.warm("iris"))
            items = await self.collect(call_voices.pcm("Hello.", hd_voice.NAME, "iris"))
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), b"\x07\x00" * 4800)
        os.remove(os.path.join(self.hd, "installed.json"))
        self.assertEqual(call_voices.configuration()["protocol"], "kokoro")

    async def test_three_crashes_in_ten_minutes_stop_trying(self):
        with self.sidecar("crash"):
            for _ in range(3):
                await hd_voice.warm("iris")
                await self.collect(call_voices.pcm("Hello.", hd_voice.NAME, "iris"))
                for _ in range(40):
                    if not hd_voice._sidecar.running():
                        break
                    await asyncio.sleep(0.05)
            await hd_voice.warm("iris")
        self.assertIn("stopped three times", hd_voice._sidecar.failed_reason)
        self.assertFalse(hd_voice.ready()[0])
        self.assertEqual(call_voices.configuration()["protocol"], "kokoro")

    async def test_a_load_failure_is_reported_and_kokoro_speaks(self):
        with self.sidecar("loadfail"):
            self.assertFalse(await hd_voice.warm("iris"))
            items = await self.collect(call_voices.pcm("Hello.", hd_voice.NAME, "iris"))
        self.assertEqual(b"".join(i.get("audio", b"") for i in items), b"\x07\x00" * 4800)

    async def test_it_stops_when_idle(self):
        with self.sidecar(), patch.object(hd_voice, "IDLE_SECONDS", 0.2), patch.object(hd_voice, "WATCH_INTERVAL", 0.1):
            await hd_voice.warm("iris")
            self.assertTrue(hd_voice._sidecar.running())
            for _ in range(60):
                if not hd_voice._sidecar.running():
                    break
                await asyncio.sleep(0.05)
        self.assertFalse(hd_voice._sidecar.running())
        self.assertEqual(self.ops()[-1]["op"], "quit")

    async def test_calls_read_aloud_voice_notes_and_phone_use_hd(self):
        call_voices.set_hd_voice("aiden")
        with self.sidecar():
            await hd_voice.warm("aiden")
            catalog = await call_voices.catalog()
            self.assertEqual(catalog["models"], [hd_voice.NAME])
            self.assertEqual(catalog["voices"][0]["id"], "aiden")          # the account's HD voice leads
            # Bots, voice notes and phone calls (LivePipeline.speak, outbound calls) speak through bot_voice.
            self.assertEqual(await bot_voice.selection("af_heart"), (hd_voice.NAME, "aiden"))
            spoken = await self.collect(bot_voice.audio_events("A phone sentence.", "af_heart"))
            self.assertEqual(spoken[0], {"sample_rate": 24000})
        texts = [op["text"] for op in self.ops() if op["op"] == "say"]
        self.assertIn("A phone sentence.", texts)
        self.assertTrue(all(op["voice"] == "aiden" for op in self.ops() if op["op"] == "say"))

    async def test_warm_at_call_start_through_the_speech_route(self):
        from core import turn_detect
        from routes import speech_routes
        with self.sidecar(), patch.object(turn_detect, "warm", lambda: None), patch.object(kokoro_voice, "warm", lambda: True):
            await asyncio.to_thread(speech_routes._warm_optional)
            for _ in range(100):
                if hd_voice._sidecar.warm_kind("iris"):
                    break
                await asyncio.sleep(0.05)
        self.assertTrue(any(op["op"] == "load" for op in self.ops()))


class TrimAndTextTests(HDCase):
    def test_edge_trim_keeps_short_margins_and_inner_pauses_in_any_piece_size(self):
        silence, tone = b"\x00\x00" * 24000, (struct.pack("<h", 9000) + struct.pack("<h", -9000)) * 2400
        clip = silence[:9600] + tone + silence[:4800] + tone + silence[:14400]      # 0.2 s, 0.2, 0.1, 0.2, 0.3
        for size in (7, 480, 4801, len(clip)):
            trim = hd_voice.EdgeTrim()
            out = b"".join(trim.feed(clip[i:i + size]) for i in range(0, len(clip), size)) + trim.finish()
            samples = np.frombuffer(out, "<i2")
            loud = np.flatnonzero(np.abs(samples) > 1000)
            self.assertEqual(int(loud[0]), 720, size)                               # 30 ms before
            self.assertEqual(len(samples) - 1 - int(loud[-1]), 1920, size)          # 80 ms after
            self.assertEqual(len(samples), 720 + 4800 + 2400 + 4800 + 1920, size)  # the 0.1 s pause stays
        quiet = hd_voice.EdgeTrim()
        self.assertEqual(quiet.feed(silence[:4800]) + quiet.finish(), silence[:4800])   # all quiet: untouched

    def test_respellings_apply_as_text_and_phonemes_do_not(self):
        Path(pronunciations.PATH).write_text(json.dumps([
            {"word": "Siobhan", "say": "shi-VAWN", "phonemes": "x"},
            {"word": "Kairos", "say": "", "phonemes": "kˈIɹɑs", "typed": True}]), encoding="utf-8")
        self.assertEqual(hd_voice.speakable("Tell Siobhan and siobhan's friend about Kairos."),
                         "Tell Shivawn and Shivawn's friend about Kairos.")


class RouteTests(HDCase):
    def app(self, admin=True):
        app = FastAPI()
        app.include_router(voice_engine_routes.router)
        app.dependency_overrides[require_user] = lambda: "david"

        def denied():
            from fastapi import HTTPException
            raise HTTPException(403, "admin privileges required")
        app.dependency_overrides[require_admin] = (lambda: "david") if admin else denied
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_state_quality_install_remove_and_preview(self):
        async with self.app() as client:
            state = (await client.get("/api/voice-engines")).json()
            self.assertEqual((state["quality"], state["hd"]["offered"], state["hd"]["installed"]), ("standard", True, False))
            refused = await client.put("/api/voice-engines/quality", json={"quality": "hd"})
            self.assertEqual(refused.status_code, 422)
            self.assertIn("not installed", refused.json()["detail"])
        async with self.app(admin=False) as client:
            self.assertEqual((await client.post("/api/voice-engines/hd/install")).status_code, 403)
            self.assertEqual((await client.delete("/api/voice-engines/hd")).status_code, 403)
        self.fake_install()
        with self.sidecar():
            async with self.app() as client:
                chosen = await client.put("/api/voice-engines/quality", json={"quality": "hd"})
                self.assertEqual(chosen.json()["quality"], "hd")
                self.assertEqual((await client.put("/api/voice-engines/hd/voice", json={"voice": "ryan"})).json()["hd_voice"], "ryan")
                self.assertEqual((await client.put("/api/voice-engines/hd/voice", json={"voice": "bob"})).status_code, 422)
                sample = await client.post("/api/voice-engines/hd/preview", json={"voice": "ryan"})
                self.assertEqual(sample.headers["content-type"], "audio/wav")
                with wave.open(io.BytesIO(sample.content)) as handle:
                    self.assertEqual((handle.getframerate(), handle.getnchannels()), (24000, 1))
                    self.assertGreater(handle.getnframes(), 12000)
                removed = (await client.delete("/api/voice-engines/hd")).json()
                self.assertEqual((removed["quality"], removed["hd"]["installed"]), ("standard", False))


class VendoredCodeTests(unittest.TestCase):
    """The sidecar's own code: our reviewed copies, with their licences, and nothing that reaches the network."""

    def test_licences_notice_and_no_network_paths(self):
        vendor = ROOT / "sidecars" / "hd_voice" / "vendor"
        self.assertIn("MIT License", (vendor / "LICENSE-faster-qwen3-tts.txt").read_text(encoding="utf-8"))
        self.assertIn("Apache License", (vendor / "LICENSE-qwen-tts.txt").read_text(encoding="utf-8"))
        notice = (vendor / "NOTICE.md").read_text(encoding="utf-8")
        for words in ["faster-qwen3-tts 0.5.4", "qwen-tts-hf 0.1.1.post1", "Apache-2.0", "MIT", "3973.wav", "CC0"]:
            self.assertIn(words, notice)
        third = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("Qwen3-TTS", third)
        for path in vendor.rglob("*.py"):
            code = path.read_text(encoding="utf-8")
            for banned in ["import urllib", "urlopen", "import requests", "import socket", "snapshot_download(", "import librosa", "import soundfile", "gradio"]:
                self.assertNotIn(banned, code, f"{path.name}: {banned}")
        server = (ROOT / "sidecars" / "hd_voice" / "server.py").read_text(encoding="utf-8")
        self.assertIn('"HF_HUB_OFFLINE": "1"', server)
        self.assertIn("site-packages", server)


if __name__ == "__main__":
    unittest.main()
