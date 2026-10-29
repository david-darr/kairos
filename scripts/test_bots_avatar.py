"""Bots Phase 1, unit U2: avatar pictures, generation and the saved image connection (2026-10-29).

Spec: phase-1-design.md 3.1 and 5.2. Throwaway data folder; the image server is an
httpx mock transport, so nothing leaves the machine.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_avatar.py
"""
import asyncio
import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-avatar-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from core.middleware import require_admin, require_user  # noqa: E402
from routes import agent_routes  # noqa: E402
from services import bot_avatar_service as avatars  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(agent_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)
_COUNTER = [0]


def image_bytes(fmt="PNG", size=(16, 16)):
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 120, 40)).save(buffer, fmt)
    return buffer.getvalue()


class AvatarTestCase(unittest.TestCase):
    def setUp(self):
        _COUNTER[0] += 1
        self.bot = agent_service.create(f"Avatar bot {_COUNTER[0]}")
        self.id = self.bot["id"]
        self.addCleanup(lambda: agent_service.get(self.id) and agent_service.delete(self.id))
        self.addCleanup(avatars.clear_provider)
        self.addCleanup(setattr, avatars, "_transport", None)

    def upload(self, data, path=None):
        return web.post(path or f"/api/agents/{self.id}/avatar-image", content=data,
                        headers={"Content-Type": "application/octet-stream"})

    def apply(self, asset_id, **extra):
        return web.put(f"/api/agents/{self.id}/avatar-image", json={"asset_id": asset_id, **extra})

    def save_provider(self, handler, kind="openai"):
        avatars._transport = httpx.MockTransport(handler)
        return web.put("/api/agents/avatar-provider", json={"kind": kind, "key": "sk-test-key-123456"})


class UploadTests(AvatarTestCase):
    def test_png_jpeg_gif_and_webp_are_accepted_and_served_with_safe_headers(self):
        for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp")):
            staged = self.upload(image_bytes(fmt))
            self.assertEqual(staged.status_code, 200, (fmt, staged.text))
            self.assertEqual(staged.json()["mime"], mime)
            served = web.get(f"/api/agents/{self.id}/avatar-image/{staged.json()['asset_id']}")
            self.assertEqual(served.status_code, 200)
            self.assertEqual(served.headers["content-type"], mime)
            self.assertEqual(served.headers["x-content-type-options"], "nosniff")
            self.assertIn("sandbox", served.headers["content-security-policy"])
            self.assertEqual(served.content, image_bytes(fmt) if fmt == "PNG" else served.content)

    def test_svg_html_and_garbage_are_refused_whatever_they_are_called(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>'
        for data in (svg, b"<html><script>1</script></html>", b"GIF89a-not-really", b"\x89PNG\r\n\x1a\nbroken", b""):
            self.assertEqual(self.upload(data).status_code, 400, data[:20])
        truncated = image_bytes("PNG", (64, 64))[:-30]
        self.assertEqual(self.upload(truncated).status_code, 400)

    def test_size_and_dimension_limits(self):
        self.assertEqual(self.upload(b"x" * (avatars.MAX_UPLOAD_BYTES + 1)).status_code, 413)
        with self.assertRaises(avatars.AvatarError):
            avatars.inspect_image(b"x" * (avatars.MAX_UPLOAD_BYTES + 1))
        original = avatars.MAX_SIDE
        avatars.MAX_SIDE = 10
        self.addCleanup(setattr, avatars, "MAX_SIDE", original)
        self.assertEqual(self.upload(image_bytes("PNG", (11, 4))).status_code, 400)
        self.assertEqual(self.upload(image_bytes("PNG", (10, 10))).status_code, 200)

    def test_a_staged_picture_is_not_shown_until_applied_with_valid_framing(self):
        staged = self.upload(image_bytes()).json()
        self.assertIsNone(agent_service.get(self.id)["avatar_image"])
        for bad in ({"zoom": 0.5}, {"zoom": 3.5}, {"focus_x": -0.1}, {"focus_y": 1.2}, {"shape": "triangle"}):
            self.assertIn(self.apply(staged["asset_id"], **bad).status_code, (400, 422), bad)
        self.assertIsNone(agent_service.get(self.id)["avatar_image"])
        ok = self.apply(staged["asset_id"], shape="rounded", zoom=2, focus_x=0.25, focus_y=0.75)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(agent_service.get(self.id)["avatar_image"],
                         {"asset_id": staged["asset_id"], "shape": "rounded", "zoom": 2, "focus_x": 0.25, "focus_y": 0.75})
        self.assertEqual(ok.json()["avatar"], self.bot["avatar"], "the Kip spec is untouched")

    def test_reset_clears_image_and_expression_and_restores_the_kip(self):
        staged = self.upload(image_bytes()).json()
        self.apply(staged["asset_id"])
        web.patch(f"/api/agents/{self.id}", json={"mascot_expression": "success"})
        reset = web.put(f"/api/agents/{self.id}/avatar-image", json={"asset_id": None})
        self.assertEqual(reset.status_code, 200)
        agent = agent_service.get(self.id)
        self.assertEqual((agent["avatar_image"], agent["mascot_expression"]), (None, None))
        self.assertEqual(agent["avatar"], self.bot["avatar"])

    def test_assets_are_owned_by_their_bot_and_asset_ids_cannot_traverse(self):
        other = agent_service.create(f"Avatar other {_COUNTER[0]}")
        self.addCleanup(lambda: agent_service.delete(other["id"]))
        staged = self.upload(image_bytes()).json()
        self.assertEqual(web.get(f"/api/agents/{other['id']}/avatar-image/{staged['asset_id']}").status_code, 404)
        self.assertEqual(web.put(f"/api/agents/{other['id']}/avatar-image",
                                 json={"asset_id": staged["asset_id"]}).status_code, 400)
        for bad in ("..%2F..%2Fagents.json", "A" * 32, "0" * 31, staged["asset_id"] + "0"):
            self.assertEqual(web.get(f"/api/agents/{self.id}/avatar-image/{bad}").status_code, 404, bad)
        self.assertEqual(self.upload(image_bytes(), "/api/agents/nobody/avatar-image").status_code, 404)

    def test_external_urls_in_the_record_are_refused(self):
        self.assertIn(web.patch(f"/api/agents/{self.id}", json={"avatar_image": {
            "asset_id": "https://example.com/x.png", "shape": "circle", "zoom": 1, "focus_x": 0, "focus_y": 0}}).status_code,
                      (400, 422))

    def test_deleting_the_bot_removes_its_pictures(self):
        staged = self.upload(image_bytes()).json()
        folder = avatars._scope_dir(avatars.bot_scope(self.id))
        self.assertTrue(any(folder.glob(staged["asset_id"] + ".*")))
        agent_service.delete(self.id)
        self.assertFalse(folder.exists())


class GenerationTests(AvatarTestCase):
    def png_answer(self, request):
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]})

    def test_the_connection_is_saved_without_ever_returning_the_key(self):
        saved = self.save_provider(self.png_answer)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotIn("sk-test-key", saved.text)
        self.assertEqual(saved.json(), web.get("/api/agents/avatar-provider").json())
        self.assertEqual(saved.json()["kind"], "openai")
        self.assertNotIn("sk-test-key", Path(avatars.CONFIG_FILE).read_text(encoding="utf-8"), "stored encrypted")
        self.assertEqual(web.delete("/api/agents/avatar-provider").json()["configured"], False)

    def test_connection_input_is_checked(self):
        for body in ({"kind": "other", "key": "sk-test-key-123456"}, {"kind": "openai", "key": "short"},
                     {"kind": "compatible", "key": "sk-test-key-123456"},
                     {"kind": "compatible", "key": "sk-test-key-123456", "base_url": "http://example.com/v1"},
                     {"kind": "compatible", "key": "sk-test-key-123456", "base_url": "https://u:p@example.com/v1"},
                     {"kind": "openai", "key": "sk-test-key-123456", "model": "bad model!"}):
            self.assertIn(web.put("/api/agents/avatar-provider", json=body).status_code, (400, 422), body)
        ok = web.put("/api/agents/avatar-provider", json={"kind": "compatible", "key": "sk-test-key-123456",
                                                         "base_url": "http://localhost:8080/v1", "model": "local-image"})
        self.assertEqual(ok.status_code, 200, ok.text)

    def test_a_picture_is_generated_staged_and_applied(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["auth"] = request.headers["authorization"]
            seen["body"] = json.loads(request.content)
            return self.png_answer(request)
        self.save_provider(handler, kind="xai")
        response = web.post(f"/api/agents/{self.id}/avatar-image/generate", json={"direction": "a friendly fox"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(seen["url"], "https://api.x.ai/v1/images/generations")
        self.assertEqual(seen["auth"], "Bearer sk-test-key-123456")
        self.assertEqual(seen["body"]["response_format"], "b64_json")
        self.assertIn("a friendly fox", seen["body"]["prompt"])
        staged = response.json()
        self.assertIsNone(agent_service.get(self.id)["avatar_image"], "staging does not change the look")
        applied = self.apply(staged["asset_id"], expected_snapshot=staged["snapshot"])
        self.assertEqual(applied.status_code, 200, applied.text)

    def test_a_late_result_cannot_overwrite_a_newer_edit(self):
        self.save_provider(self.png_answer)
        started = web.get(f"/api/agents/{self.id}").json()["avatar_snapshot"]
        staged = web.post(f"/api/agents/{self.id}/avatar-image/generate",
                          json={"direction": "a fox", "snapshot": started}).json()
        web.patch(f"/api/agents/{self.id}", json={"mascot_expression": "thinking"})
        late = self.apply(staged["asset_id"], expected_snapshot=staged["snapshot"])
        self.assertEqual(late.status_code, 409)
        self.assertIsNone(agent_service.get(self.id)["avatar_image"])

    def test_the_direction_is_bounded_and_required(self):
        self.save_provider(self.png_answer)
        for direction in ("", "   ", "x" * 401):
            self.assertIn(web.post(f"/api/agents/{self.id}/avatar-image/generate",
                                   json={"direction": direction}).status_code, (400, 422), len(direction))

    def test_no_connection_is_a_clear_refusal_not_a_crash(self):
        response = web.post(f"/api/agents/{self.id}/avatar-image/generate", json={"direction": "a fox"})
        self.assertEqual(response.status_code, 502)
        self.assertIn("image connection", response.json()["detail"])

    def test_provider_failures_never_leave_a_half_staged_picture(self):
        folder = avatars._scope_dir(avatars.bot_scope(self.id))
        answers = {
            "refused": lambda r: httpx.Response(401, json={"error": "no"}),
            "timeout": lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=r)),
            "unreachable": lambda r: (_ for _ in ()).throw(httpx.ConnectError("down", request=r)),
            "url only": lambda r: httpx.Response(200, json={"data": [{"url": "https://evil.example/x.png"}]}),
            "bad base64": lambda r: httpx.Response(200, json={"data": [{"b64_json": "@@@not base64@@@"}]}),
            "not a picture": lambda r: httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b"<svg/>").decode()}]}),
            "empty": lambda r: httpx.Response(200, json={"data": []}),
        }
        for name, handler in answers.items():
            self.save_provider(handler)
            response = web.post(f"/api/agents/{self.id}/avatar-image/generate", json={"direction": "a fox"})
            self.assertEqual(response.status_code, 502, (name, response.text))
            self.assertFalse(folder.exists() and list(folder.glob("*.*")), name)

    def test_a_provider_url_is_never_fetched(self):
        fetched = []

        def handler(request):
            fetched.append(str(request.url))
            return httpx.Response(200, json={"data": [{"url": "https://evil.example/x.png"}]})
        self.save_provider(handler)
        web.post(f"/api/agents/{self.id}/avatar-image/generate", json={"direction": "a fox"})
        self.assertEqual(fetched, ["https://api.openai.com/v1/images/generations"])

    def test_the_decoded_limit_is_15_megabytes(self):
        original = avatars.MAX_GENERATED_BYTES
        avatars.MAX_GENERATED_BYTES = 30
        self.addCleanup(setattr, avatars, "MAX_GENERATED_BYTES", original)
        self.save_provider(self.png_answer)
        response = web.post(f"/api/agents/{self.id}/avatar-image/generate", json={"direction": "a fox"})
        self.assertEqual(response.status_code, 502)


class DraftTests(AvatarTestCase):
    def test_a_new_bots_picture_is_owner_bound_and_adopted_at_creation(self):
        staged = self.upload(image_bytes(), "/api/agents/avatar-drafts").json()
        self.assertEqual(web.get(f"/api/agents/avatar-drafts/{staged['asset_id']}").status_code, 200)
        framing = {"asset_id": staged["asset_id"], "shape": "square", "zoom": 1.5, "focus_x": 0.4, "focus_y": 0.6}
        created = web.post("/api/agents/configured", json={"profile": {"name": f"Drafted {_COUNTER[0]}",
                                                                      "avatar_image": framing}})
        self.assertEqual(created.status_code, 200, created.text)
        agent = created.json()["agent"]
        self.addCleanup(lambda: agent_service.delete(agent["id"]))
        self.assertEqual(agent["avatar_image"], framing)
        self.assertEqual(web.get(f"/api/agents/{agent['id']}/avatar-image/{staged['asset_id']}").status_code, 200)
        self.assertEqual(web.get(f"/api/agents/avatar-drafts/{staged['asset_id']}").status_code, 404, "moved, not copied")

    def test_another_persons_draft_is_not_adoptable(self):
        staged = self.upload(image_bytes(), "/api/agents/avatar-drafts").json()
        with self.assertRaises(avatars.AvatarError):
            avatars.adopt_draft("someone-else", staged["asset_id"], self.id)
        self.assertNotEqual(avatars.draft_scope("david"), avatars.draft_scope("someone-else"))

    def test_a_missing_draft_makes_a_warning_not_a_failed_bot(self):
        framing = {"asset_id": "a" * 32, "shape": "circle", "zoom": 1, "focus_x": 0.5, "focus_y": 0.5}
        created = web.post("/api/agents/configured", json={"profile": {"name": f"No draft {_COUNTER[0]}",
                                                                      "avatar_image": framing}})
        self.assertEqual(created.status_code, 200, created.text)
        self.addCleanup(lambda: agent_service.delete(created.json()["agent"]["id"]))
        self.assertIsNone(created.json()["agent"]["avatar_image"])
        self.assertTrue(any("picture was not added" in w for w in created.json()["warnings"]))

    def test_drafts_are_capped_and_generation_can_target_the_draft_scope(self):
        for _ in range(avatars.MAX_DRAFTS + 3):
            self.upload(image_bytes(), "/api/agents/avatar-drafts")
        folder = avatars._scope_dir(avatars.draft_scope("david"))
        self.assertLessEqual(len(list(folder.glob("*.*"))), avatars.MAX_DRAFTS)
        self.save_provider(lambda r: httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(image_bytes()).decode()}]}))
        made = web.post("/api/agents/avatar-drafts/generate", json={"direction": "a fox"})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(web.get(f"/api/agents/avatar-drafts/{made.json()['asset_id']}").status_code, 200)


if __name__ == "__main__":
    unittest.main()
