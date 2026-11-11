"""Studio through the real folder loader and isolated design/video stores."""
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
DATA = TestDataDirectory(prefix="studio-test-")
os.environ["JARVIS_DATA_DIR"] = DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(DATA.name, "vault"))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from core import accounts, custom_tabs, design_store, design_systems, settings, tab_api, tab_folders, video_render, video_store
from core.middleware import require_user
settings.update_settings(enabled_tab_templates=["studio"])
custom_tabs.discover()
from kairos_tabs.studio import routes


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.app.dependency_overrides[require_user] = lambda: "alice"
        self.client = TestClient(self.app)
        self.admin = patch.object(tab_api, "is_admin", return_value=False)
        self.admin.start()
        self.addCleanup(self.admin.stop)

    def design(self, owner="alice", boards=2):
        data, _ = design_store.create("My story", owner=owner, chat_key_=None, by="You", design_system="sport",
                                      boards=[{"title": f"Board {i + 1}", "frame": "slide"} for i in range(boards)])
        out = io.BytesIO()
        Image.new("RGB", (24, 24), "green").save(out, "PNG")
        raw = out.getvalue()
        asset = design_store.add_asset(data["id"], raw, "png")
        def edit(draft, files):
            for i, (slug, _) in enumerate(design_store.ordered_boards(draft)):
                files[slug] = f'<main><h1>Heading <span>{i + 1}</span></h1><h2>Ignore this</h2><img src="{asset}"></main>'
            return None, "Fixture headings and image"
        design_store.change(data["id"], edit, by="You", tool="test")
        return data, asset, raw

    def test_manifest_real_loader_and_store_offer(self):
        metadata = tab_folders.metadata(str(ROOT / "tabs/studio"))
        self.assertEqual((metadata["slug"], metadata["name"], metadata["version"], metadata["api"]), ("studio", "Studio", "1.0.0", 1))
        self.assertEqual(metadata["blurb"], "Make and edit videos in any look, then download them.")
        self.assertIn("FFmpeg", metadata["reads"])
        self.assertIn("<svg", metadata["icon_svg"])
        entries = custom_tabs.discover()
        self.assertTrue(any(slug == "studio" for slug, _ in entries))
        self.assertTrue(any(e["slug"] == "studio" for e in custom_tabs.list_templates()))
        self.assertEqual(routes.__package__, "kairos_tabs.studio")
        self.assertTrue(routes.api.is_on)

    def test_from_design_preserves_look_and_copies_real_asset(self):
        data, asset, raw = self.design()
        response = self.client.post("/api/tab-studio/from-design", json={"design_id": data["id"]})
        self.assertEqual(response.status_code, 200, response.text)
        p = response.json()
        self.assertEqual((p["owner"], p["look"]), ("alice", "sport"))
        self.assertEqual([b["kind"] for b in p["beats"]], ["title", "image", "statement", "image", "end"])
        self.assertEqual([b["text"] for b in p["beats"]], ["Heading 1", "Heading 1", "Heading 2", "Heading 2", "Heading 2"])
        self.assertEqual(p["beats"][1]["image"], asset)
        self.assertEqual(video_store.asset_path(p["id"], asset[7:]).read_bytes(), raw)
        self.assertEqual(video_store.validate(p), p)
        self.assertEqual(self.client.get(f'/api/tab-studio/designs/{data["id"]}/assets').json(), [asset])

    def test_private_design_and_video_are_hidden(self):
        data, _, _ = self.design(owner="bob")
        before = len(video_store.list_for_user("alice"))
        self.assertEqual(self.client.post("/api/tab-studio/from-design", json={"design_id": data["id"]}).status_code, 404)
        self.assertEqual(self.client.get(f'/api/tab-studio/designs/{data["id"]}/assets').status_code, 404)
        self.assertEqual(len(video_store.list_for_user("alice")), before)
        p = video_store.create("Private", owner="bob", look="sport", beats=[{"id": "end", "kind": "end", "bars": 1}])
        self.assertEqual(self.client.get(f'/api/tab-studio/videos/{p["id"]}/resources').status_code, 404)
        self.assertEqual(self.client.post('/api/tab-studio/chat', json={"video_id": p["id"]}).status_code, 404)

    def test_routes_require_auth_and_enabled_tab(self):
        self.app.dependency_overrides.clear()
        auth = patch('core.middleware.auth_enabled', return_value=True)
        auth.start()
        self.addCleanup(auth.stop)
        for method, path, body in [("get", "/looks", None), ("get", "/tokens/sport", None),
                                    ("get", "/videos/012345abcdef/resources", None),
                                    ("get", "/designs/012345abcdef/assets", None),
                                    ("post", "/from-design", {"design_id": "012345abcdef"}),
                                    ("post", "/chat", {})]:
            response = getattr(self.client, method)("/api/tab-studio" + path, **({"json": body} if body is not None else {}))
            self.assertIn(response.status_code, (401, 403), response.text)
        self.app.dependency_overrides[require_user] = lambda: "alice"
        with patch.object(type(routes.api), "is_on", new_callable=unittest.mock.PropertyMock, return_value=False):
            self.assertEqual(self.client.get("/api/tab-studio/looks").status_code, 409)

    def test_tokens_match_render_player_and_default_is_visible(self):
        response = self.client.get("/api/tab-studio/tokens/sport")
        self.assertEqual(response.status_code, 200, response.text)
        system = design_systems.get("sport")
        self.assertEqual(response.json()["variables"], design_systems.variables(system["tokens"]))
        self.assertEqual(response.json()["font_css"], design_systems.font_faces("sport", "/api/design-fonts"))
        looks = self.client.get("/api/tab-studio/looks").json()
        self.assertIn(looks["default"], [look["id"] for look in looks["looks"]])
        self.assertEqual(self.client.get("/api/tab-studio/tokens/not-a-look").status_code, 404)

    def test_recover_jobs_renders_and_assets_without_exposing_paths(self):
        data, asset, _ = self.design()
        p = self.client.post("/api/tab-studio/from-design", json={"design_id": data["id"]}).json()
        folder = video_store._folder(p["id"]) / "renders"
        for name in ["16-9-v1.mp4", "sheet-16-9.png", "thumb-16-9.png", "soundtrack.wav", "secret.txt", "16-9-v0.mp4"]:
            (folder / name).write_bytes(b"fixture")
        job = {"id": "studio-job", "video_id": p["id"], "aspect": "16:9", "status": "rendering 30/60", "path": "private-path"}
        with patch.dict(video_render._jobs, {job["id"]: job}), patch.dict(video_render._owners, {job["id"]: accounts.effective_account()}):
            response = self.client.get(f'/api/tab-studio/videos/{p["id"]}/resources')
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["assets"], [asset])
        self.assertIn("16-9-v1.mp4", result["renders"])
        self.assertNotIn("secret.txt", result["renders"])
        self.assertNotIn("16-9-v0.mp4", result["renders"])
        self.assertEqual(result["thumbnail"], "thumb-16-9.png")
        self.assertNotIn("path", result["jobs"][0])

    def test_chat_reused_per_owner_and_linked_for_video_tools(self):
        data, _, _ = self.design()
        p = self.client.post("/api/tab-studio/from-design", json={"design_id": data["id"]}).json()
        first = self.client.post('/api/tab-studio/chat', json={"video_id": p["id"]})
        self.assertEqual(first.status_code, 200, first.text)
        session_id = first.json()["session_id"]
        self.assertEqual(self.client.post('/api/tab-studio/chat', json={"video_id": p["id"]}).json()["session_id"], session_id)
        self.assertEqual(video_store.require_chat_access(p["id"], session_id)["id"], p["id"])
        self.assertTrue(design_store.design_mode(session_id))

    def test_waveform_reads_each_spoken_line_and_nothing_else(self):
        import wave
        import numpy as np
        from core import video_narration
        p = video_store.create("Narrated", owner="alice", look="sport", beats=[
            {"id": "a", "kind": "title", "text": "Hi", "bars": 1}, {"id": "b", "kind": "statement", "text": "Line", "bars": 1}])
        key = "0123456789abcdef"
        path = video_narration.clip_path(p["id"], key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tone = (np.sin(np.linspace(0, 200 * np.pi, video_narration.RATE)) * 16000).astype("<i2")   # one second at half scale
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(video_narration.RATE); out.writeframes(tone.tobytes())
        stored = video_store.get(p["id"])
        stored["beats"][1]["spoken"] = {"key": key, "seconds": 1.0, "parts": [[.25, 1.25, "Line."]]}
        stored["beats"][0]["spoken"] = {"key": "fedcba9876543210", "seconds": 1.0, "parts": [[.25, 1.25, "Gone."]]}   # no file
        with patch.object(video_store, "get", return_value=stored):
            response = self.client.get(f'/api/tab-studio/videos/{p["id"]}/waveform')
        self.assertEqual(response.status_code, 200, response.text)
        beats = response.json()["beats"]
        self.assertEqual(list(beats), ["b"], "A beat without its audio file is left out")
        self.assertEqual((beats["b"]["key"], beats["b"]["rate"], beats["b"]["offset"], len(beats["b"]["peaks"])), (key, 40, video_store.LEAD, 40))
        self.assertTrue(120 <= max(beats["b"]["peaks"]) <= 130, max(beats["b"]["peaks"]))
        private = video_store.create("Private", owner="bob", look="sport", beats=[{"id": "end", "kind": "end", "bars": 1}])
        self.assertEqual(self.client.get(f'/api/tab-studio/videos/{private["id"]}/waveform').status_code, 404)

    def test_editor_lists_match_the_server(self):
        """The inspector's choices (static/js/studioEditorModel.js, tabs/studio/view.js) are the schema's own lists."""
        import re
        from core import character_store, style_packs
        model = (ROOT / "static/js/studioEditorModel.js").read_text(encoding="utf-8")
        view = (ROOT / "tabs/studio/view.js").read_text(encoding="utf-8")
        def js_list(source, name):
            body = re.search(rf"export const {name} = \[(.*?)\];|const {name} = \[(.*?)\];", source, re.S)
            return re.findall(r"'([^']+)'", body.group(1) or body.group(2))
        self.assertEqual(js_list(model, "SETTINGS"), list(style_packs.SETTINGS))
        self.assertEqual(js_list(model, "SHOTS"), list(style_packs.SHOTS))
        self.assertEqual(js_list(model, "PROPS"), list(style_packs.PROPS))
        self.assertEqual(js_list(model, "VIEWS"), list(character_store.VIEWS))
        self.assertEqual(js_list(model, "EXPRESSIONS"), list(character_store.EXPRESSIONS))
        self.assertEqual(js_list(model, "ACTIONS"), list(video_store.ACTIONS))
        self.assertEqual(js_list(view, "PALETTES"), list(style_packs.PALETTES))
        self.assertEqual(js_list(model, "STAGE_SETS"), list(style_packs.STAGE_SETS))
        self.assertEqual(js_list(model, "STAGE_PROPS"), list(style_packs.STAGE_PROPS))
        self.assertEqual(js_list(model, "STAGE_FACINGS"), list(style_packs.STAGE_FACINGS))
        self.assertIn(f"MAX_PEOPLE = {style_packs.MAX_PEOPLE}, MAX_LABELS = {style_packs.MAX_LABELS}", model)
        # Pack C's voxel form and Pack C classic's story form (polish for 2.3.0) offer the schema's own choices.
        for name in ("VOXEL_WORLDS", "VOXEL_TIMES", "VOXEL_PROPS", "VOXEL_LOOKS", "STORY_PLACES", "STORY_TIMES", "STORY_POSES", "STORY_MOODS",
                     "STORY_SHOTS", "STORY_FX", "STORY_PROPS", "STORY_SFX"):
            self.assertEqual(js_list(model, name), list(getattr(style_packs, name)), name)
        self.assertIn(f"VOXEL_MAX_PEOPLE = {style_packs.VOXEL_MAX_PEOPLE};", model)
        self.assertIn(f"STORY_MAX_CAST = {style_packs.STORY_MAX_CAST}, STORY_MAX_SHOTS = {style_packs.STORY_MAX_SHOTS}, STORY_MAX_FX = 4, STORY_MAX_PROPS = 6, STORY_MAX_SFX = 6, STORY_MAX_KEYS = 8", model)
        self.assertIn(f"STORY_GAP = [{video_store.STORY_GAP_RANGE[0]}, {video_store.STORY_GAP_RANGE[1]}], STORY_HOLD = [{video_store.STORY_HOLD_RANGE[0]}, {int(video_store.STORY_HOLD_RANGE[1])}]".replace("0.", "."), model)
        self.assertEqual(js_list(view, "KINDS"), list(video_store.KINDS))
        self.assertEqual(js_list(view, "CAMERAS"), list(video_store.CAMERAS))
        self.assertEqual(js_list(view, "TRANSITIONS"), list(video_store.TRANSITIONS))
        self.assertIn(f"LEAD = {video_store.LEAD}".replace("0.", "."), model)
        # Tracks and clips (step 3): the editor's lists are core/video_tracks.py's.
        from core import video_tracks
        self.assertEqual(js_list(model, "CLIP_COLORS"), list(video_tracks.COLORS))
        self.assertEqual(js_list(model, "CLIP_SHAPES"), list(video_tracks.SHAPES))
        self.assertEqual(js_list(model, "TRACK_KINDS"), list(video_tracks.TRACK_KINDS))
        self.assertIn(f"MAX_TRACKS = {video_tracks.MAX_TRACKS}, MAX_TRACK_CLIPS = {video_tracks.MAX_TRACK_CLIPS}, MAX_CLIPS = {video_tracks.MAX_CLIPS}", model)
        overlay = (ROOT / "static/motion/overlay.js").read_text(encoding="utf-8")
        self.assertEqual(js_list(overlay, "COLORS"), list(video_tracks.COLORS))
        for path in ("tabs/studio/view.js", "static/js/studioEditorModel.js", "static/js/studioTimeline.js", "static/js/studioSceneForm.js", "static/js/studioStageForm.js",
                     "static/js/studioVoxelForm.js", "static/js/studioStoryForm.js",
                     "static/js/studioClipForm.js", "static/motion/overlay.js", "static/css/studio-editor.css"):
            self.assertNotIn("—", (ROOT / path).read_text(encoding="utf-8"), path + " has an em-dash")

    def test_failed_asset_copy_rolls_back_new_project(self):
        data, _, _ = self.design()
        before = {p["id"] for p in video_store.list_for_user("alice")}
        with patch.object(tab_api, "video_copy_design_asset", side_effect=ValueError("asset: unavailable")):
            response = self.client.post('/api/tab-studio/from-design', json={"design_id": data["id"]})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(before, {p["id"] for p in video_store.list_for_user("alice")})


if __name__ == "__main__":
    unittest.main()
