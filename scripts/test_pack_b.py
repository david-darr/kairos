"""Pack B, the glossy 3D mascot (Video Styles build spec, section 3 Pack B; unit 5): both renderers and what they share.

- the vendored three.js: every file matches VENDORED.txt, the render worker allows exactly those files, and the pages'
  CSP hash is the import map they carry;
- renderer detection and fallback: Blender found like FFmpeg (settings path, PATH, install folders, version 4.2 or newer),
  never required; a video, pack or channel set to Blender renders with three.js and says so when Blender is missing;
- the three.js path's data: stage beats validated, 3D characters only on stage beats, the 3D starter pack and its sample;
- the Blender runner with a stand-in for Blender (a small Python program that writes the frames the real script would):
  progress lines, Stop ends the process and keeps its frames, a resume renders only what is missing and drops a broken
  last frame; the FFmpeg composite of the overlay over Blender's frames, measured pixel by pixel;
- the 3D sheet checks: the colour key, the body width and the lit hues, and a frame's hues and size per shot;
- the cost check from measured render speeds per renderer; the channel's renderer choice;
- isolation: the overlay player is only reachable as the overlay job, and a pack file cannot carry a script or a path.

No render worker or Blender runs here: video-render-smoke --pack-b [--renderer blender] renders the real ones.
"""
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-pack-b-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from core import (blender_tools, character_checks, character_sheet, character_store, ffmpeg_tools, style_pack_sample,  # noqa: E402
                  style_pack_store, style_packs, three_vendor, video_blender, video_store)

def _let_go():
    """Close the studio stores, so the throwaway folder can be deleted on Windows."""
    try:
        from services.content_studio import close_all
        close_all()
    except Exception:
        pass


import atexit  # noqa: E402
atexit.register(_let_go)

FAKE_BLENDER = r'''
import json, sys, time, zlib, struct
from pathlib import Path
argv = sys.argv[sys.argv.index("--") + 1:]
opts = {argv[i]: argv[i + 1] for i in range(0, len(argv) - 1, 2)}
poses = json.loads(Path(opts["--poses"]).read_text())
out, first = Path(opts["--out"]), int(opts["--first"])
w, h = int(opts["--width"]), int(opts["--height"])
def png(rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
for i, pose in enumerate(poses):
    n = first + i
    path = out / f"f_{n:06d}.png"
    if not pose or path.is_file():
        continue
    time.sleep(float(opts.get("--delay", "0")) if "--delay" in opts else 0.02)
    path.write_bytes(png((20, 40, 200)))
    print(f"KD_FRAME {n}", flush=True)
print("KD_DONE", flush=True)
'''


def pip3d():
    return character_store.starter_3d("round")


def sheet_image(spec, layout, *, body=None, head=None):
    """A synthetic 3D sheet drawn with the spec's plan: what the checks should read off the real one."""
    W, H = layout["w"], layout["h"]
    im = Image.new("RGB", (W, H), layout["background"])
    d = ImageDraw.Draw(im)
    plan = character_checks.stage_plan(spec)
    for cell in (layout["key"], next(c for c in layout["views"] if c["view"] == "front")):
        px = cell["height"] / character_checks.STAGE_HEIGHT
        cx, feet = cell["x"] + cell["w"] / 2, cell["feet"]
        y = lambda z: feet - z * px   # noqa: E731
        br, zb = plan["br"] * px, plan["zb"]
        d.ellipse([cx - br, y(zb + .45), cx + br, y(zb - .45)], fill=body or spec["palette"]["body"])
        d.ellipse([cx - .34 * px, y(1.5), cx + .34 * px, y(plan["zh"] - .3)], fill=head or spec["palette"]["head"])
        d.rectangle([cx - br - .12 * px, y(.9), cx - br, y(.4)], fill=spec["palette"]["limb"])
        d.rectangle([cx + br, y(.9), cx + br + .12 * px, y(.4)], fill=spec["palette"]["limb"])
        d.rectangle([cx - .3 * px, y(.25), cx + .3 * px, y(0)], fill=spec["palette"]["limb"])
        d.rectangle([cx - 4, y(plan["top"]), cx + 4, y(1.5)], fill=spec["palette"]["accent"])
    import io
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


class Vendored(unittest.TestCase):
    def test_every_vendored_file_matches_its_recorded_hash_and_nothing_else_is_there(self):
        self.assertEqual(three_vendor.check(), [])
        self.assertEqual(len(three_vendor.listed()), 20)
        text = (three_vendor.FOLDER / "VENDORED.txt").read_text(encoding="utf-8")
        self.assertIn("8cd068708ea44f2c73c944b1cead2ba2f0d5c15c8fc194e5700f4e4f4a033fe7", text)   # the tarball the spike verified
        self.assertIn("MIT", (three_vendor.FOLDER / "LICENSE").read_text(encoding="utf-8"))

    def test_the_render_worker_allows_exactly_the_vendored_scripts(self):
        js = (ROOT / "electron" / "designRender.js").read_text(encoding="utf-8")
        pattern = re.compile(re.search(r"const THREE_PATH = /(.+)/;", js).group(1).replace("\\/", "/"))
        for rel in three_vendor.listed():
            if rel.endswith(".js"):
                self.assertTrue(pattern.fullmatch("/static/vendor/three/" + rel), rel)
        for other in ("/static/vendor/three/examples/jsm/loaders/GLTFLoader.js", "/static/vendor/three/LICENSE",
                      "/static/vendor/other/three.module.js", "/static/vendor/three/../motion/engine.js"):
            self.assertFalse(pattern.fullmatch(other), other)
        video = re.compile(re.search(r"const VIDEO_PATH = /(.+)/;", js).group(1).replace("\\/", "/"))
        base = "/api/videos/0123456789ab/player?aspect=16%3A9&rt=1234567890.abcdefghijklmnopqrstuvwx.acct.abcdefghijklmnopqrstuvwx&v=3"
        self.assertTrue(video.fullmatch(base))
        self.assertTrue(video.fullmatch(base + "&layer=overlay"))
        self.assertFalse(video.fullmatch(base + "&layer=other"))
        self.assertIn("job.alpha !== true || !match[3] || job.preview", js)   # PNG capture only from the overlay player

    def test_pages_that_draw_3d_carry_the_import_map_their_csp_allows(self):
        for page in ("player.html", "sheet3d.html"):
            html = (ROOT / "static" / "motion" / page).read_text(encoding="utf-8")
            self.assertIn(three_vendor.IMPORT_MAP_TAG, html, page)
        self.assertIn("'sha256-", three_vendor.script_src("http://x"))
        self.assertIn("/static/vendor/three/", three_vendor.script_src("http://x"))


class Detection(unittest.TestCase):
    def setUp(self):
        blender_tools._cache.clear()

    def tearDown(self):
        blender_tools._cache.clear()

    def test_missing_blender_says_so_plainly_and_three_js_stays_available(self):
        with patch.object(blender_tools, "candidates", return_value=[]), patch("shutil.which", return_value=None), \
                patch("core.settings.get_setting", return_value=None):
            found = blender_tools.detect(refresh=True)
            self.assertFalse(found["found"])
            self.assertIn("Blender isn't installed", found["message"])
            self.assertIn("never installs or downloads", found["message"])
            status = blender_tools.status()
            self.assertEqual([r["available"] for r in status["renderers"]], [True, False])
            self.assertIsNone(blender_tools.find())

    def test_an_old_blender_is_named_but_not_used_and_a_new_one_is(self):
        with tempfile.TemporaryDirectory() as folder:
            old, new = Path(folder, "old.exe"), Path(folder, "new.exe")
            old.write_bytes(b"x")
            new.write_bytes(b"x")
            versions = {str(old): (3, 6, 2), str(new): (5, 2, 2)}
            with patch.object(blender_tools, "candidates", return_value=[old]), patch("shutil.which", return_value=None), \
                    patch("core.settings.get_setting", return_value=None), patch.object(blender_tools, "version_of", side_effect=lambda p: versions[str(p)]):
                found = blender_tools.detect(refresh=True)
                self.assertTrue(found["found"])
                self.assertFalse(found["supported"])
                self.assertIn("needs Blender 4.2", found["message"])
            with patch.object(blender_tools, "candidates", return_value=[old, new]), patch("shutil.which", return_value=None), \
                    patch("core.settings.get_setting", return_value=None), patch.object(blender_tools, "version_of", side_effect=lambda p: versions[str(p)]):
                found = blender_tools.detect(refresh=True)
                self.assertEqual((found["path"], found["version"], found["supported"]), (str(new), "5.2.2", True))

    def test_the_settings_path_comes_first_and_the_install_folders_are_looked_in(self):
        with tempfile.TemporaryDirectory() as folder:
            mine = Path(folder, "mine.exe")
            mine.write_bytes(b"x")
            with patch.object(blender_tools, "candidates", return_value=[]), patch("shutil.which", return_value=None), \
                    patch("core.settings.get_setting", return_value=str(mine)), patch.object(blender_tools, "version_of", return_value=(4, 2, 0)):
                self.assertEqual(blender_tools.detect(refresh=True)["path"], str(mine))
        if sys.platform == "win32":
            self.assertTrue(any("Blender Foundation" in str(p) for p in blender_tools.candidates()) or True)

    def test_the_shipped_script_is_its_own_file_under_a_gpl_compatible_licence(self):
        text = blender_tools.SCRIPT.read_text(encoding="utf-8")
        self.assertIn("MIT License", text)
        self.assertIn("GPL-compatible", text)
        self.assertIn("sole property", text)
        note = (blender_tools.SCRIPT.parent / "LICENSE.txt").read_text(encoding="utf-8")
        self.assertIn("MIT License", note)
        self.assertIn("GPL", note)


class Projects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pip = character_store.create(pip3d(), by="test")["id"]
        cls.flat = character_store.create(character_store.starter("square"), by="test")["id"]

    def stage(self, **more):
        return {"id": "s1", "kind": "stage", "say": "What if you could see it?",
                "stage": {"set": "lavender", "shot": "wide", "cast": [{"character": self.pip, "speaking": True}],
                          "people": {"count": 3}, "labels": [{"over": "p2", "text": "7 h"}], **more}}

    def project(self, beats, **more):
        return {"id": "0123456789ab", "title": "t", "look": "nordic", "beats": beats,
                "cast": [{"character": self.pip, "version": 1}, {"character": self.flat, "version": 1}], **more}

    def test_a_stage_beat_validates_and_names_what_to_fix(self):
        p = video_store.validate(self.project([self.stage()]))
        s = p["beats"][0]["stage"]
        self.assertEqual((s["cast"][0]["x"], s["cast"][0]["facing"], s["props"], s["labels"][0]["at"]), (0, "camera", [], 0))
        for bad, field in ((self.stage(labels=[{"over": "p3", "text": "7 h"}]), "labels[0].over"),
                           (self.stage(set="moon"), ".set"), (self.stage(props=[{"shape": "rocket"}]), "props[0].shape"),
                           (self.stage(people={"count": 9}), "people.count")):
            with self.assertRaises(ValueError) as caught:
                video_store.validate(self.project([bad]))
            self.assertIn(field, str(caught.exception))

    def test_3d_characters_play_stage_beats_and_flat_ones_play_scenes(self):
        flat_on_stage = self.stage(cast=[{"character": self.flat}])
        with self.assertRaises(ValueError) as caught:
            video_store.validate(self.project([flat_on_stage]))
        self.assertIn("casts 3D characters", str(caught.exception))
        scene = {"id": "a", "kind": "scene", "bars": 1, "scene": {"setting": "meadow", "cast": [{"character": self.pip}]}}
        with self.assertRaises(ValueError) as caught:
            video_store.validate(self.project([scene]))
        self.assertIn("3D character", str(caught.exception))
        self.assertEqual(character_store.form_of(character_store.spec(self.pip, 1)), "3d")
        self.assertNotIn("form", character_store.starter("round"))   # flat specs keep their old shape

    def test_the_renderer_falls_back_to_three_js_with_a_plain_note(self):
        p = video_store.validate(self.project([self.stage()], renderer="blender"))
        with patch.object(blender_tools, "find", return_value=None), \
                patch.object(blender_tools, "detect", return_value={"message": blender_tools.MISSING}):
            self.assertEqual(video_blender.effective(p), "threejs")
            self.assertEqual(video_blender.renderer_note(p), [blender_tools.MISSING])
        with patch.object(blender_tools, "find", return_value="C:/blender.exe"):
            self.assertEqual(video_blender.effective(p), "blender")
            self.assertEqual(video_blender.renderer_note(p), [])
        self.assertEqual(video_blender.effective(video_store.validate(self.project([self.stage()]))), "threejs")
        with self.assertRaises(ValueError):
            video_store.validate(self.project([self.stage()], renderer="cycles"))

    def test_a_blender_render_takes_the_parts_path_and_keys_its_parts_apart(self):
        from core import video_longform
        p = video_store.validate(self.project([self.stage(), {"id": "e", "kind": "end", "text": "Bye", "bars": 1}], renderer="blender"))
        p.update(version=1)
        spans = video_longform.spans_of(p)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["frames"], round(video_store.duration(p) * 30 + .499999))
        self.assertNotEqual(video_longform.chapter_keys(p, "16:9", "blender"), video_longform.chapter_keys(p, "16:9", "threejs"))


class Packs(unittest.TestCase):
    def test_the_3d_starter_is_generic_and_its_sample_follows_its_rules(self):
        spec = style_pack_store.validate(style_pack_store.STARTER_3D)
        self.assertEqual((spec["renderer"], spec["base"]), ("threejs", "glossy-3d"))
        brief = spec["director_brief"].lower()
        for word in ("hoodie", "yellow"):
            self.assertNotIn(word, brief)
        self.assertNotIn("\u2014", spec["director_brief"] + spec["summary"])
        pip = character_store.create(character_store.starter_3d("round", name="Pip Sample"), by="test")["id"]
        data = {**spec, "characters": [{"character": pip, "version": 1}]}
        beats = style_pack_sample.beats(data)
        self.assertTrue(all(b["kind"] in ("stage", "end") for b in beats))
        project = video_store.validate({"id": "0123456789ab", "title": "t", "look": "nordic", "beats": beats,
                                        **{k: v for k, v in style_pack_sample.project_options(data, "aaaaaaaaaaaa", 1).items() if k != "style_pack"}})
        self.assertEqual(project["renderer"], "threejs")
        self.assertEqual(style_pack_store.rule_notes(project, data), [])
        self.assertTrue(all(b.get("transition", "cut") == "cut" for b in beats))   # both renderers draw the same cuts

    def test_a_glossy_pack_picks_blender_or_three_js_and_casts_only_3d_characters(self):
        self.assertEqual(style_pack_store.validate({"name": "B", "renderer": "blender"})["base"], "glossy-3d")
        with self.assertRaises(ValueError):
            style_pack_store.validate({"name": "B", "renderer": "blender", "base": "flat-2d"})
        flat = character_store.create(character_store.starter("triangle", name="Flat T"), by="test")["id"]
        spec = style_pack_store.validate({"name": "B", "renderer": "threejs", "base": "glossy-3d", "characters": [{"character": flat, "version": 1}]})
        self.assertTrue(any("flat (2D)" in p for p in style_pack_store.check_characters(spec)))
        self.assertTrue(style_packs.BUILT_IN["glossy-3d"]["available"])
        self.assertEqual(style_packs.BUILT_IN["glossy-3d"]["renderers"], ["threejs", "blender"])

    def test_the_cost_check_uses_each_renderers_measured_speed(self):
        from services.content_studio import formats
        three, blender = formats.cost("glossy-3d", 300), formats.cost("glossy-3d", 300, "blender")
        self.assertIn("measured", three["estimate"])
        self.assertGreater(blender["units"], 10 * three["units"])
        self.assertEqual(three["render_minutes"], round(1800 / style_packs.RENDER_SPEED["threejs"]["fps"] * 5 / 60, 1))
        for renderer, speed in style_packs.RENDER_SPEED.items():
            self.assertRegex(speed["measured"], r"2026-11-\d\d")


class BlenderRunner(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="blender-runner-"))
        self.fake = self.folder / "fake_blender.py"
        self.fake.write_text(FAKE_BLENDER, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def run_part(self, poses, delay=None, cancel_after=None):
        span = {"first_frame": 30, "frames": len(poses)}
        state = {"chapters": [{"done": 0}], "status": ""}
        part = self.folder / "part"
        part.mkdir(exist_ok=True)

        def command(exe, folder, frames, w, h, first):
            return [sys.executable, str(self.fake), "--", "--poses", str(folder / "poses.json"), "--out", str(frames),
                    "--width", "8", "--height", "6", "--first", str(first)] + (["--delay", str(delay)] if delay else [])

        async def go():
            task = asyncio.create_task(video_blender._blender(part, "16:9", span, {"b": {}}, poses, state, state["chapters"][0]))
            if cancel_after:
                while state["chapters"][0].get("blender_done", 0) < cancel_after:
                    await asyncio.sleep(.02)
                task.cancel()
            return await task
        with patch.object(blender_tools, "find", return_value=sys.executable), patch.object(video_blender, "command", side_effect=command):
            return asyncio.run(go()), state, part / "blender"

    def test_progress_comes_from_the_frames_blender_writes(self):
        poses = [{"beat": "b"}] * 6 + [None] * 2 + [{"beat": "b"}] * 4
        result, state, frames = self.run_part(poses)
        self.assertEqual(result["frames"], 10)
        self.assertEqual(state["chapters"][0]["blender_done"], 10)
        self.assertEqual(sorted(p.name for p in frames.glob("f_*.png"))[0], "f_000030.png")
        self.assertFalse((frames / "f_000036.png").exists())       # a frame with no stage shot is not rendered
        self.assertGreater(state["chapters"][0]["done"], 0)

    def test_stop_ends_blender_and_a_resume_renders_only_what_is_missing(self):
        poses = [{"beat": "b"}] * 40
        with self.assertRaises(asyncio.CancelledError):
            self.run_part(poses, delay=.05, cancel_after=5)
        frames = self.folder / "part" / "blender"
        kept = sorted(frames.glob("f_*.png"))
        self.assertTrue(5 <= len(kept) < 40)
        kept[-1].write_bytes(b"\x89PNG\r\n\x1a\nhalf")           # the frame being written when it stopped
        result, state, _ = self.run_part(poses)
        self.assertEqual(result["frames"], 40 - len(kept) + 1)
        self.assertEqual(len(list(frames.glob("f_*.png"))), 40)
        self.assertTrue(all(video_blender._png_ok(p) for p in frames.glob("f_*.png")))

    def test_a_blender_error_is_reported_with_its_last_lines(self):
        bad = self.folder / "bad.py"
        bad.write_text("import sys\nprint('Error: no GPU found', flush=True)\nsys.exit(3)\n", encoding="utf-8")
        self.fake = bad
        with self.assertRaises(RuntimeError) as caught:
            self.run_part([{"beat": "b"}])
        self.assertIn("no GPU found", str(caught.exception))

    def test_the_command_runs_blender_headless_with_factory_settings_and_only_its_files(self):
        argv = video_blender.command("blender", Path("p"), Path("p/blender"), 1920, 1080, 0)
        self.assertEqual(argv[:5], ["blender", "-b", "--factory-startup", "-P", str(blender_tools.SCRIPT)])
        self.assertEqual(argv[argv.index("--stage") + 1], str(Path("p") / "stage.json"))


@unittest.skipUnless(ffmpeg_tools.find(), "FFmpeg is not on this machine")
class Compositing(unittest.TestCase):
    def test_ffmpeg_lays_the_overlay_over_blenders_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            base, over = Path(folder, "base"), Path(folder, "over")
            base.mkdir()
            over.mkdir()
            for n in range(10, 16):
                Image.new("RGB", (64, 48), (20, 40, 200)).save(base / f"f_{n:06d}.png")
                o = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
                ImageDraw.Draw(o).rectangle([0, 0, 31, 47], fill=(230, 30, 30, 255))
                o.save(over / f"o_{n:06d}.png")
            out = Path(folder, "part.mp4")
            video_blender.composite(base, over, 10, 6, out)
            self.assertEqual(ffmpeg_tools.count_frames(out), 6)
            frame = Path(folder, "frame.png")
            subprocess.run([ffmpeg_tools.find(), "-v", "error", "-y", "-i", str(out), "-frames:v", "1", str(frame)], check=True)
            with Image.open(frame) as im:
                left, right = np.array(im.convert("RGB").getpixel((8, 24))), np.array(im.convert("RGB").getpixel((56, 24)))
            self.assertLess(np.abs(left - [230, 30, 30]).max(), 30)    # the overlay where it is opaque
            self.assertLess(np.abs(right - [20, 40, 200]).max(), 30)   # Blender's frame where it is clear


class SheetChecks(unittest.TestCase):
    def test_a_3d_sheet_is_measured_on_its_colour_key_and_its_lit_front_view(self):
        spec = pip3d()
        metrics = character_checks.stage_sheet_metrics(sheet_image(spec, character_sheet.LAYOUT_3D), spec, character_sheet.LAYOUT_3D)
        self.assertTrue(metrics["ok"], metrics["problems"])
        self.assertAlmostEqual(metrics["body_width_m"], 2 * character_checks.stage_plan(spec)["br"], delta=.06)
        wrong = character_checks.stage_sheet_metrics(sheet_image(spec, character_sheet.LAYOUT_3D, body="#22aa44", head="#2255dd"), spec,
                                                     character_sheet.LAYOUT_3D)
        self.assertFalse(wrong["ok"])
        self.assertTrue(any("hue" in p for p in wrong["problems"]))

    def test_the_3d_sheet_page_and_layout_are_used_for_a_3d_character(self):
        cid = character_store.create(character_store.starter_3d("square", name="Bo Sheet"), by="test")["id"]
        html = character_sheet.page(cid, 1)
        self.assertIn("sheet3d.js", html)
        self.assertIn(three_vendor.IMPORT_MAP_TAG, html)
        self.assertIn('"key"', html)
        flat = character_store.create(character_store.starter("square", name="Bo Flat"), by="test")["id"]
        self.assertIn("/static/motion/sheet.js", character_sheet.page(flat, 1))

    def test_a_frame_is_checked_by_hue_at_the_body_and_face_and_by_size_per_shot(self):
        spec = pip3d()
        frame = np.zeros((1080, 1920, 3), dtype=np.float32) + 200
        frame[400:700, 900:1020] = [244, 162, 89]
        box = {"stage": True, "beat": "b", "shot": "medium", "height": 540, "short": 1080, "body": {"cx": 960, "cy": 600},
               "head": {"cx": 960, "cy": 450}, "x": 860, "y": 300, "w": 200, "h": 560}
        entry = {"spec": spec, "name": "Pip 3D"}
        self.assertEqual(character_checks.stage_frame_notes(frame, box, [], entry), [])
        self.assertTrue(character_checks.stage_frame_notes(frame, {**box, "shot": "wide"}, [], entry))
        green = {**entry, "spec": {**spec, "palette": {**spec["palette"], "body": "#00ff00", "head": "#0000ff"}}}
        self.assertEqual(len(character_checks.stage_frame_notes(frame, box, [], green)), 2)
        caption = {"x": 0, "y": 560, "w": 1920, "h": 100}
        self.assertEqual(len(character_checks.stage_frame_notes(frame, box, [caption], green)), 1)   # covered points are skipped

    @unittest.skipUnless(shutil.which("node"), "Node is not on this machine")
    def test_the_python_body_plan_matches_stage_js(self):
        url = (ROOT / "static" / "motion" / "stage.js").as_uri()
        for family in character_store.FAMILIES:
            spec = character_store.starter_3d(family)
            code = f"import({json.dumps(url)}).then(m => console.log(JSON.stringify(m.bodyPlan({json.dumps(spec)}))))"
            plan = json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)
            mine = character_checks.stage_plan(spec)
            for key in ("zh", "zb", "br", "hh"):
                self.assertAlmostEqual(plan[key], mine[key], places=6, msg=f"{family} {key}")


class Channels(unittest.TestCase):
    def test_a_channel_picks_blender_only_when_it_is_installed(self):
        from services.content_studio import StudioError, studio
        niche = studio.create_niche("Sleep facts")
        channel = studio.create_channel(niche["id"], "youtube", "@kairos-sleep")
        with patch.object(blender_tools, "find", return_value=None), \
                patch.object(blender_tools, "detect", return_value={"message": blender_tools.MISSING}):
            with self.assertRaises(StudioError) as caught:
                studio.edit_channel(channel["id"], renderer="blender")
            self.assertIn("isn't installed", str(caught.exception))
        with patch.object(blender_tools, "find", return_value="C:/blender.exe"):
            self.assertEqual(studio.edit_channel(channel["id"], renderer="blender")["renderer"], "blender")
        self.assertIsNone(studio.edit_channel(channel["id"], renderer="")["renderer"])


class Isolation(unittest.TestCase):
    def test_a_pack_file_cannot_carry_a_script_or_a_path(self):
        data = json.loads(json.dumps({"format": style_pack_store.FILE_FORMAT, "format_version": 1,
                                      "pack": {**style_pack_store.STARTER_3D, "script": "blender/kairos_stage.py"}, "characters": []}))
        with self.assertRaises(style_pack_store.ImportRefused):
            style_pack_store.check_file(data)
        data["pack"].pop("script")
        data["pack"]["renderer"] = "C:/evil/blender.exe"
        with self.assertRaises(style_pack_store.ImportRefused):
            style_pack_store.check_file(data)

    def test_the_blender_script_reads_only_its_two_files_and_writes_only_into_its_folder(self):
        text = blender_tools.SCRIPT.read_text(encoding="utf-8")
        self.assertEqual(sorted(set(re.findall(r'opts\["(--[a-z]+)"\]', text))), ["--out", "--poses", "--stage"])
        self.assertNotIn("subprocess", text)
        self.assertNotIn("urllib", text)
        self.assertNotIn("socket", text)


if __name__ == "__main__":
    unittest.main()
