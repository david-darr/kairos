"""Offline image engine, licensed photo, palette, tool and route regressions.

All data is temporary and every HTTP call uses MockTransport.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/test_image_tools.py
"""
import asyncio
import base64
import io
import json
import os
import re
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data_support import TestDataDirectory

_DATA = TestDataDirectory(prefix="kairos-images-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from core import image_providers as providers, image_search as photos, image_treatments as treatments
from core import design_store, design_export, tool_registry, image_tools, image_gen
from core.atomic_io import write_json_atomic
from core.middleware import require_admin
from core.session_manager import session_manager
from core.turn_taint import TurnTaint
from routes import image_routes

PUBLIC = [(None, None, None, "", ("93.184.216.34", 443))]
photos._resolve = lambda *a, **k: PUBLIC  # Host lookups stay offline; one test points a name at a private address.

LIGHT = {"--ds-text": "#101820", "--ds-bg": "#fff3df", "--ds-accent": "#e24b37", "--ds-accent-2": "#187e89"}
DARK = {**LIGHT, "--ds-text": "#fff3df", "--ds-bg": "#101820"}


def run(coro):
    return asyncio.run(coro)


def png(size=(48, 32)):
    out = io.BytesIO()
    image = Image.new("RGB", size)
    image.putdata([((i*7) % 256, (i*13) % 256, (i*19) % 256) for i in range(size[0]*size[1])])
    image.save(out, "PNG")
    return out.getvalue()


def payload(n=1):
    return {"data": [{"b64_json": base64.b64encode(png()).decode()} for _ in range(n)]}


def photo(**extra):
    return {"id": "photo-1", "title": "Football", "creator": "Alex", "license": "cc-by", "license_version": "4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/", "url": "https://photos.example/image.png",
            "width": 1200, "height": 800, "foreign_landing_url": "https://photos.example/page", "attribution": "Alex, CC BY 4.0",
            "mature": False, **extra}


class ProviderTests(unittest.TestCase):
    def setUp(self):
        providers.clear_provider()
        providers.set_daily_limit(50)
        Path(providers.usage_file()).unlink(missing_ok=True)
        self.addCleanup(providers.clear_provider)
        self.addCleanup(setattr, providers, "_transport", None)

    def save(self, **kw):
        return providers.save_provider("openai", "sk-test-secret-12345", **kw)

    def test_save_state_clear_and_encryption(self):
        state = self.save()
        self.assertTrue(state["configured"])
        self.assertEqual(state["daily_limit"], 50)
        self.assertEqual(state["used_today"], 0)
        self.assertNotIn("key", state)
        self.assertNotIn("sk-test-secret", Path(providers.CONFIG_FILE).read_text())
        self.assertFalse(providers.clear_provider()["configured"])

    def test_input_and_limit_clamping(self):
        self.assertEqual(self.save(daily_limit=999)["daily_limit"], 500)
        self.assertEqual(self.save(daily_limit=-3)["daily_limit"], 0)
        for args in (("bad", "long-enough"), ("openai", "x"), ("compatible", "long-enough")):
            with self.subTest(args=args), self.assertRaises(providers.ImageError):
                providers.save_provider(*args)
        for size, count in (("wide", 1), ("square", 0), ("square", 5), ("square", True)):
            with self.subTest(size=size, count=count), self.assertRaises(providers.ImageError):
                run(providers.generate("photo", size, count))

    def test_generate_size_count_and_decoding(self):
        self.save()
        for size, mapped in providers.SIZES.items():
            for count in range(1, 5):
                with self.subTest(size=size, count=count):
                    def handler(req):
                        body = json.loads(req.content)
                        self.assertEqual(body["size"], mapped)
                        self.assertEqual(body["n"], count)
                        self.assertNotIn("response_format", body)
                        self.assertEqual(req.headers["authorization"], "Bearer sk-test-secret-12345")
                        return httpx.Response(200, json=payload(count))
                    self.assertEqual(run(providers.generate("football", size, count, transport=httpx.MockTransport(handler))), [png()]*count)

    def test_compatible_base64_body(self):
        providers.save_provider("compatible", "test-key-123", "http://localhost:9999/v1", "image-model")
        def handler(req):
            self.assertEqual(json.loads(req.content)["response_format"], "b64_json")
            return httpx.Response(200, json=payload())
        run(providers.generate("photo", transport=httpx.MockTransport(handler)))

    def test_refusals_timeout_and_bad_payloads(self):
        self.save()
        handlers = [lambda r: httpx.Response(401), lambda r: httpx.Response(500),
                    lambda r: httpx.Response(200, json={"data": [{"b64_json": "!!!"}]}),
                    lambda r: httpx.Response(200, json={"data": [{"url": "https://example.org"}]}),
                    lambda r: httpx.Response(200, json={"data": []}),
                    lambda r: httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b"not a photo").decode()}]})]
        def timeout(req):
            raise httpx.ReadTimeout("mock", request=req)
        handlers.append(timeout)
        for handler in handlers:
            with self.subTest(handler=handler), self.assertRaises(providers.ImageUnavailable):
                run(providers.generate("photo", transport=httpx.MockTransport(handler)))
        # Refusals, timeouts and an empty list cost nothing; the three pictures the provider sent but
        # Kairos couldn't use were billed, so they count toward the daily cap.
        self.assertEqual(providers.provider_state()["used_today"], 3)

    def test_oversize_and_unreadable_key(self):
        self.save()
        with patch.object(providers, "MAX_GENERATED_BYTES", 10), self.assertRaises(providers.ImageUnavailable):
            run(providers.generate("photo", transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload()))))
        with patch.object(providers.secret_storage, "decrypt", side_effect=ValueError("broken")), self.assertRaises(providers.ImageUnavailable):
            run(providers.generate("photo"))

    def test_network_error_and_refusal_messages(self):
        self.save()
        def broken(req):
            raise httpx.ConnectError("mock", request=req)
        with self.assertRaisesRegex(providers.ImageUnavailable, "could not be reached"):
            run(providers.generate("photo", transport=httpx.MockTransport(broken)))
        for status in (401, 500):
            with self.subTest(status=status), self.assertRaisesRegex(providers.ImageUnavailable, str(status)):
                run(providers.generate("photo", transport=httpx.MockTransport(lambda r: httpx.Response(status))))

    def test_concurrent_requests_reserve_budget(self):
        self.save(daily_limit=1)
        async def scenario():
            entered, finish = asyncio.Event(), asyncio.Event()
            async def handler(req):
                entered.set()
                await finish.wait()
                return httpx.Response(200, json=payload())
            transport = httpx.MockTransport(handler)
            first = asyncio.create_task(providers.generate("first", transport=transport))
            await entered.wait()
            try:
                with self.assertRaises(providers.ImageUnavailable):
                    await providers.generate("second", transport=transport)
            finally:
                finish.set()
                await first
        run(scenario())
        self.assertEqual(providers.provider_state()["used_today"], 1)

    def test_daily_limit_partial_response_reset_and_off(self):
        self.save(daily_limit=2)
        transport = httpx.MockTransport(lambda r: httpx.Response(200, json=payload()))
        self.assertEqual(len(run(providers.generate("photo", count=2, transport=transport))), 1)
        self.assertEqual(providers.provider_state()["used_today"], 1)
        with self.assertRaisesRegex(providers.ImageUnavailable, "daily image limit \\(2\\)"):
            run(providers.generate("photo", count=2, transport=transport))
        run(providers.generate("photo", transport=transport))
        with self.assertRaises(providers.ImageUnavailable):
            run(providers.generate("photo", transport=transport))
        write_json_atomic(providers.usage_file(), {"date": "2000-01-01", "count": 500})
        self.assertEqual(providers.provider_state()["used_today"], 0)
        run(providers.generate("photo", transport=transport))
        providers.set_daily_limit(0)
        run(providers.generate("photo", count=4, transport=transport))
        self.assertEqual(providers.provider_state()["used_today"], 2)

    def test_models_check_never_generates(self):
        self.save()
        def handler(req):
            self.assertEqual(req.method, "GET")
            self.assertEqual(req.url.path, "/v1/models")
            return httpx.Response(200, json={"data": []})
        self.assertEqual(run(providers.test(httpx.MockTransport(handler))), {"ok": True})
        self.assertEqual(providers.provider_state()["used_today"], 0)
        self.assertFalse(run(providers.test(httpx.MockTransport(lambda r: httpx.Response(401))))["ok"])
        providers.clear_provider()
        self.assertFalse(run(providers.test())["ok"])


class SearchTests(unittest.TestCase):
    def test_search_params_parsing_and_filters(self):
        items = [photo(), photo(id="small", width=200), photo(id="empty", url=""), photo(id="adult", mature=True),
                 photo(id="portrait", width=900, height=1200), photo(id="square", width=900, height=900)]
        def handler(req):
            self.assertEqual(req.url.params["license_type"], "commercial,modification")
            self.assertEqual(req.url.params["mature"], "false")
            self.assertEqual(req.url.params["page_size"], "12")
            return httpx.Response(200, json={"result_count": len(items), "results": items})
        transport = httpx.MockTransport(handler)
        self.assertEqual([p["id"] for p in run(photos.search("soccer", transport=transport))], ["photo-1", "portrait", "square"])
        for orientation, expected in (("landscape", "photo-1"), ("portrait", "portrait"), ("square", "square")):
            with self.subTest(orientation=orientation):
                found = run(photos.search("soccer", orientation=orientation, transport=transport))
                self.assertEqual([p["id"] for p in found], [expected])
                self.assertEqual(found[0]["landing"], items[0]["foreign_landing_url"])

    def fetch_transport(self, url="https://photos.example/image.png", response=None):
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo(url=url))
            return response or httpx.Response(200, content=png(), headers={"Content-Type": "image/png"})
        return httpx.MockTransport(handler)

    def test_fetch_success(self):
        raw, ext, credit = run(photos.fetch("photo-1", transport=self.fetch_transport()))
        self.assertEqual(raw, png())
        self.assertEqual(ext, "png")
        self.assertEqual(credit["creator"], "Alex")

    def test_addresses_refused_before_download(self):
        for url in ("http://photos.example/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://LOCALHOST./x"):
            with self.subTest(url=url), self.assertRaises(photos.ImageSearchError):
                run(photos.fetch("photo-1", transport=self.fetch_transport(url)))

    def test_honest_agent_retry_and_openverse_fallback(self):
        seen = []
        def handler(req):
            seen.append((req.url.host, req.url.path, req.headers.get("user-agent", "")))
            if req.url.path.endswith("/thumb/"):
                return httpx.Response(200, content=png(), headers={"content-type": "image/png"})
            if req.url.host == "api.openverse.org":
                if sum(1 for h, p, _ in seen if p == req.url.path) == 1:
                    return httpx.Response(500)  # Openverse's occasional 5xx: retried once.
                return httpx.Response(200, json=photo())
            return httpx.Response(502)  # The photo's own host refuses: Openverse's copy is used.
        raw, ext, credit = run(photos.fetch("photo-1", transport=httpx.MockTransport(handler)))
        self.assertEqual((raw, ext, credit["creator"]), (png(), "png", "Alex"))
        self.assertTrue(all(ua.startswith("Kairos/") for _, _, ua in seen), "Kairos says who it is")
        self.assertTrue(any(p.endswith("/thumb/") for _, p, _ in seen))

    def test_public_name_on_a_private_address_refused(self):
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.169.254", "::1"):
            with self.subTest(address=address):
                photos._resolve = lambda *a, address=address, **k: [(None, None, None, "", (address, 443))]
                try:
                    with self.assertRaises(photos.ImageSearchError):
                        run(photos.fetch("photo-1", transport=self.fetch_transport()))
                finally:
                    photos._resolve = lambda *a, **k: PUBLIC

    def test_redirect_rechecked_and_max_three(self):
        for target in ("http://example.org/x", "https://127.0.0.1/x", "https://localhost/x"):
            with self.subTest(target=target), self.assertRaises(photos.ImageSearchError):
                run(photos.fetch("photo-1", transport=self.fetch_transport(response=httpx.Response(302, headers={"location": target}))))
        seen = []
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            seen.append(str(req.url))
            return httpx.Response(302, headers={"location": "/next"})
        with self.assertRaises(photos.ImageSearchError):
            run(photos.fetch("photo-1", transport=httpx.MockTransport(handler)))
        self.assertEqual(len(seen), 4)

    def test_wrong_type_and_stream_size(self):
        for response in (httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"}),
                         httpx.Response(200, content=b"x", headers={"content-type": "image/png", "content-length": str(photos.MAX_BYTES+1)})):
            with self.subTest(response=response), self.assertRaises(photos.ImageSearchError):
                run(photos.fetch("photo-1", transport=self.fetch_transport(response=response)))
        with patch.object(photos, "MAX_BYTES", 16), self.assertRaises(photos.ImageSearchError):
            run(photos.fetch("photo-1", transport=self.fetch_transport()))

    def test_three_safe_redirects_succeed(self):
        seen = []
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            seen.append(str(req.url))
            if len(seen) <= 3:
                return httpx.Response(302, headers={"location": f"/step-{len(seen)}"})
            return httpx.Response(200, content=png(), headers={"content-type": "image/png"})
        self.assertEqual(run(photos.fetch("photo-1", transport=httpx.MockTransport(handler)))[0], png())
        self.assertEqual(len(seen), 4)

    def test_stream_stops_at_limit(self):
        read = []
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                for i in range(10):
                    read.append(i)
                    yield b"x" * 65536
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            return httpx.Response(200, stream=Stream(), headers={"content-type": "image/png"})
        with patch.object(photos, "MAX_BYTES", 65536), self.assertRaises(photos.ImageSearchError):
            run(photos.fetch("photo-1", transport=httpx.MockTransport(handler)))
        self.assertEqual(read, [0, 1])

    def test_search_and_detail_failures(self):
        transport = httpx.MockTransport(lambda r: httpx.Response(500))
        with self.assertRaisesRegex(photos.ImageSearchError, "Openverse"):
            run(photos.search("football", transport=transport))
        with self.assertRaisesRegex(photos.ImageSearchError, "downloaded"):
            run(photos.fetch("photo-1", transport=transport))


class TreatmentTests(unittest.TestCase):
    def check_png(self, raw, size):
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, size)
            image.load()

    def test_all_treatments_dark_and_light(self):
        for tokens in (DARK, LIGHT):
            colors = treatments.palette(tokens)
            self.assertLess(sum(colors["dark"]), sum(colors["light"]))
            for treatment in treatments.TREATMENTS:
                with self.subTest(tokens=tokens, treatment=treatment):
                    first = treatments.apply(png(), treatment, tokens)
                    self.check_png(first, (48, 32))
                    self.assertEqual(first, treatments.apply(png(), treatment, tokens))

    def test_palette_mapping_and_grain_preserve_photo_detail(self):
        for treatment in ("ordered", "diffuse", "posterize"):
            with Image.open(io.BytesIO(treatments.apply(png(), treatment, DARK))) as image:
                self.assertTrue(set(zip(image.tobytes()[0::3], image.tobytes()[1::3], image.tobytes()[2::3])) <= set(treatments.palette(DARK).values()))
        with Image.open(io.BytesIO(png())) as original, Image.open(io.BytesIO(treatments.apply(png(), "grain", DARK))) as grained:
            self.assertNotEqual(original.tobytes(), grained.tobytes())
            self.assertTrue(all(abs(a-b) <= 22 for a, b in zip(original.tobytes(), grained.tobytes())))

    def test_all_patterns_dark_and_light(self):
        for tokens in (DARK, LIGHT):
            for kind in treatments.PATTERNS:
                with self.subTest(tokens=tokens, kind=kind):
                    first = treatments.pattern(kind, tokens, 160, 100, 7)
                    self.check_png(first, (160, 100))
                    self.assertEqual(first, treatments.pattern(kind, tokens, 160, 100, 7))

    def test_limits_and_unknown(self):
        with self.assertRaisesRegex(ValueError, "halftone"):
            treatments.apply(png(), "unknown", LIGHT)
        with self.assertRaises(ValueError):
            treatments.pattern("unknown", LIGHT)
        with patch.object(treatments, "MAX_BYTES", 1), self.assertRaises(ValueError):
            treatments.apply(png(), "duotone", LIGHT)
        with patch.object(treatments, "MAX_PIXELS", 10), self.assertRaises(ValueError):
            treatments.apply(png(), "duotone", LIGHT)
        self.check_png(treatments.apply(png((2500, 10)), "duotone", LIGHT), (2400, 10))


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.sid = session_manager.create_session("images", owner_user="local")["id"]
        self.ctx = tool_registry.ToolContext(session_id=self.sid, surface=tool_registry.OPENAI, is_admin=True, turn_taint=TurnTaint())
        self.design, _ = design_store.create("Images", owner="local", chat_key_=self.sid, by="test", design_system="sport",
                                              boards=[{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>Sport</h1>"}])
        providers.clear_provider()
        providers.set_daily_limit(0)
        self.addCleanup(providers.clear_provider)
        self.addCleanup(setattr, providers, "_transport", None)
        self.addCleanup(setattr, photos, "_transport", None)

    def invoke(self, name, args, ctx=None):
        return run(tool_registry.call(name, args, ctx or self.ctx, tool_registry.OPENAI))

    def test_no_connection_and_generate_prompt(self):
        self.assertEqual(self.invoke("image_generate", {"prompt": "football"}), image_tools.NO_CONNECTION)
        providers.save_provider("openai", "sk-test-secret-12345")
        def handler(req):
            body = json.loads(req.content)
            self.assertIn("Style:", body["prompt"])
            self.assertIn("action photography", body["prompt"])
            self.assertTrue(body["prompt"].endswith("No text, letters, logos or watermarks."))
            return httpx.Response(200, json=payload())
        providers._transport = httpx.MockTransport(handler)
        result = self.invoke("image_generate", {"prompt": "football", "size": "landscape"})
        self.assertIn("assets/", result)
        self.assertIn("48x32", result)
        self.assertIn("alt text", result)

    def test_search_use_credit_copy_export(self):
        def handler(req):
            if req.url.host != "api.openverse.org":
                return httpx.Response(200, content=png(), headers={"content-type": "image/png"})
            return httpx.Response(200, json={"results": [photo()]} if req.url.path == "/v1/images/" else photo())
        photos._transport = httpx.MockTransport(handler)
        listing = self.invoke("image_search", {"query": "soccer"})
        self.assertIn("UNTRUSTED", listing)
        self.assertIn("photo-1", listing)
        result = self.invoke("image_search", {"use": "photo-1"})
        self.assertIn("Photo: Football by Alex, CC-BY 4.0", result)
        saved = design_store.credits(self.design["id"])
        self.assertEqual(len(saved), 1)
        self.assertEqual(next(iter(saved.values()))["creator"], "Alex")
        duplicate = design_store.duplicate(self.design["id"], owner="local", by="test")
        self.assertEqual(design_store.credits(duplicate["id"]), saved)
        with zipfile.ZipFile(io.BytesIO(design_export.html_zip(self.design["id"]))) as archive:
            self.assertIn("Alex, CC BY 4.0", archive.read("CREDITS.txt").decode())

    def test_treat_pattern_and_access(self):
        asset = design_store.add_asset(self.design["id"], png(), "png")
        self.assertIn("assets/", self.invoke("image_treat", {"source": asset, "treatment": "halftone"}))
        self.assertIn("1600x500", self.invoke("image_pattern", {"size": "wide", "seed": 4}))
        self.assertIn("Not run:", self.invoke("image_treat", {"source": "assets/../../secret.png"}))
        other = tool_registry.ToolContext(session_id="unlinked", surface=tool_registry.OPENAI, is_admin=True)
        self.assertIn("Not run:", self.invoke("image_pattern", {"design_id": self.design["id"]}, other))

    def test_designless_generate_and_search_use(self):
        providers.save_provider("openai", "sk-test-secret-12345")
        providers._transport = httpx.MockTransport(lambda r: httpx.Response(200, json=payload()))
        ctx = tool_registry.ToolContext(session_id="designless", is_admin=True, surface=tool_registry.OPENAI)
        result = self.invoke("image_generate", {"prompt": "football"}, ctx)
        self.assertIn("/generated-images/", result)
        self.assertTrue(list(Path(image_gen.generated_dir()).glob("*.png")))
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            return httpx.Response(200, content=png(), headers={"content-type": "image/png"})
        photos._transport = httpx.MockTransport(handler)
        self.assertIn("/generated-images/", self.invoke("image_search", {"use": "photo-1"}, ctx))
        self.assertIn("Not run:", self.invoke("image_treat", {"source": "assets/no.png"}, ctx))
        self.assertIn("Not run:", self.invoke("image_pattern", {}, ctx))

    def test_video_only_chat_saves_pictures_into_its_video(self):
        from core import video_checks, video_store
        sid = session_manager.create_session("video", owner_user="local")["id"]
        ctx = tool_registry.ToolContext(session_id=sid, surface=tool_registry.OPENAI, is_admin=True, turn_taint=TurnTaint())
        beats = [{"id": "hook", "kind": "title", "bars": 1, "text": "Start here"}, {"id": "pic", "kind": "image", "bars": 1, "text": "Saturday"},
                 {"id": "end", "kind": "end", "bars": 1, "text": "Join us"}]
        video = video_store.create("Camp", look="sport", beats=beats, owner="local", chat_key_=sid)
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            return httpx.Response(200, content=png(), headers={"content-type": "image/png"})
        photos._transport = httpx.MockTransport(handler)
        result = self.invoke("image_search", {"use": "photo-1"}, ctx)
        self.assertIn(f"is in video {video['id']}", result)
        self.assertIn("Photo: Football by Alex", result)
        asset = re.search(r"assets/[a-f0-9]{64}\.png", result).group(0)
        self.assertTrue(video_store.asset_path(video["id"], asset[7:]).is_file())
        self.assertEqual(video_store.credits(video["id"])[asset]["creator"], "Alex")
        self.assertNotIn("/generated-images/", result, "the photo is not a loose chat file")
        pattern = self.invoke("image_pattern", {"size": "wide"}, ctx)
        self.assertIn(f"is in video {video['id']}", pattern)
        # The beat uses the photo: its credit must be on screen.
        project = dict(video_store.get(video["id"]))
        project["beats"] = [dict(b, image=asset) if b["id"] == "pic" else b for b in project["beats"]]
        self.assertTrue(any("credit is not on screen" in n for n in video_checks.check(project)))
        project["beats"][-1]["sub"] = "Photo: Football by Alex, CC BY 4.0"
        self.assertFalse(any("credit is not on screen" in n for n in video_checks.check(project)))
        # A design in the chat keeps pictures in the design, as before.
        self.assertIn("/generated-images/", self.invoke("image_search", {"use": "photo-1", "design_id": None} | {}, tool_registry.ToolContext(
            session_id="designless-2", is_admin=True, surface=tool_registry.OPENAI)))

    def test_video_thumbnail_is_mid_beat(self):
        from core import video_render
        project = {"bpm": 120, "beats": [{"id": "a", "kind": "title", "bars": 1}, {"id": "b", "kind": "list", "bars": 2},
                                         {"id": "c", "kind": "statement", "bars": 2}, {"id": "end", "kind": "end", "bars": 1}]}
        # 12 s total; the quarter mark (3 s) is inside beat b (2 to 6 s), whose middle is 4 s = frame 120.
        self.assertEqual(video_render.thumb_frame(project, 30), 120)

    def test_video_variety_note(self):
        from core import video_checks
        def project(kinds):
            beats = [{"id": f"b{i}", "kind": k, "bars": 2, "text": "Short line here"} for i, k in enumerate(kinds)]
            return {"id": "000000000000", "bpm": 120, "beats": beats}
        flat = project(["title", "statement", "statement", "statement", "big-number", "end"])
        self.assertIn(video_checks.VARIETY, video_checks.variety(flat))
        mixed = project(["title", "statement", "big-number", "list", "image", "quote", "end"])
        self.assertEqual(video_checks.variety(mixed), [])
        self.assertEqual(video_checks.variety(project(["title", "statement", "statement", "end"])), [], "too short to judge")

    def test_tool_effects_and_surfaces(self):
        for name in image_tools.NAMES:
            spec = tool_registry._REGISTRY[name]
            self.assertEqual(spec.surfaces, tool_registry.ALL)
            self.assertEqual(spec.effect, tool_registry.EXTERNAL if name in ("image_generate", "image_search") else tool_registry.WRITE)

    def test_foreign_asset_and_invalid_download_are_plain_text(self):
        other, _ = design_store.create("Other", owner="local", chat_key_="elsewhere", by="test")
        asset = design_store.add_asset(other["id"], png(), "png")
        self.assertIn("Not run:", self.invoke("image_treat", {"source": asset}))
        def handler(req):
            if req.url.host == "api.openverse.org":
                return httpx.Response(200, json=photo())
            return httpx.Response(200, content=b"broken image", headers={"content-type": "image/png"})
        photos._transport = httpx.MockTransport(handler)
        self.assertIn("Not run:", self.invoke("image_search", {"use": "photo-1"}))

    def test_gating_large_small_and_design_mode(self):
        for small in (True, False):
            def names(sid):
                return {t["function"]["name"] for t in tool_registry.openai_tools(is_admin=True, small_window=small, session_id=sid)}
            self.assertTrue(image_tools.NAMES <= names(self.sid))
            # A large window lists them from the start, like design_create (a turn's tool list is fixed before
            # design_create links a design); a small window only while the chat designs.
            if small:
                self.assertFalse(image_tools.NAMES & names("unlinked"))
            else:
                self.assertTrue(image_tools.NAMES <= names("unlinked"))
            with patch.object(design_store, "design_mode", return_value=True), patch.object(image_tools.design_tools, "design_mode", return_value=True):
                self.assertTrue(image_tools.NAMES <= names("unlinked"))


class RouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(image_routes.router)
        app.dependency_overrides[require_admin] = lambda: "local"
        self.web = TestClient(app)
        providers.clear_provider()
        self.addCleanup(providers.clear_provider)
        self.addCleanup(setattr, providers, "_transport", None)

    def test_get_put_delete_limit_only_and_models(self):
        self.assertFalse(self.web.get("/api/image-provider").json()["configured"])
        self.assertEqual(self.web.put("/api/image-provider", json={"daily_limit": 9}).status_code, 400)
        saved = self.web.put("/api/image-provider", json={"kind": "openai", "key": "sk-test-key-12345", "daily_limit": 13})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotIn("sk-test", saved.text)
        self.assertEqual(saved.json()["daily_limit"], 13)
        self.assertEqual(self.web.put("/api/image-provider", json={"daily_limit": 4}).json()["daily_limit"], 4)
        self.assertEqual(self.web.get("/api/image-provider").json()["model"], "gpt-image-1")
        providers._transport = httpx.MockTransport(lambda r: httpx.Response(200) if r.url.path == "/v1/models" else httpx.Response(500))
        self.assertEqual(self.web.post("/api/image-provider/test").json(), {"ok": True})
        self.assertFalse(self.web.delete("/api/image-provider").json()["configured"])

    def test_bad_connection_and_admin_dependency(self):
        self.assertEqual(self.web.put("/api/image-provider", json={"kind": "bad", "key": "long-enough-key"}).status_code, 400)
        app = FastAPI()
        app.include_router(image_routes.router)
        self.assertTrue(all(require_admin in [d.call for d in route.dependant.dependencies] for route in app.routes if hasattr(route, "dependant")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
