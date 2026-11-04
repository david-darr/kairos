"""Video contracts without Electron or network; optional real FFmpeg encode."""
import asyncio
import base64
import copy
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="video-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from PIL import Image, ImageDraw
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import (creative_direction, design_render, design_render_bridge as bridge, design_store,
                  ffmpeg_tools, settings, tool_registry, video_audio, video_checks, video_render,
                  video_store, video_tools)
from core.middleware import SecurityHeadersMiddleware, require_user
from core import middleware
from core.session_manager import session_manager
from core.turn_taint import TurnTaint
from routes import design_routes, video_routes


def project(**changes):
    return {"id": "012345abcdef", "title": "A short story", "look": "sport", "bpm": 120, "fps": 30,
            "aspects": ["16:9"], "beats": [{"id": "hook", "kind": "title", "bars": 1, "text": "Start here"},
                                          {"id": "end", "kind": "end", "bars": 1, "text": "Try it now"}],
            "music": {"mood": "energetic", "volume": .7}, **changes}


def make(**changes):
    p = project(**changes)
    return video_store.create(**{k: v for k, v in p.items() if k != "id"}, owner="alice", chat_key_="chat-alice")


def image(fmt="JPEG", size=(320, 180), blank=False):
    im = Image.new("RGB", size, "#172536")
    if not blank:
        ImageDraw.Draw(im).rectangle((size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4), fill="white")
    out = io.BytesIO()
    im.save(out, fmt)
    return out.getvalue()


def run(coro):
    return asyncio.run(coro)


class ValidationTests(unittest.TestCase):
    def bad(self, p, path):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn(path + ":", str(caught.exception))

    def test_big_number_needs_its_number_and_field_hints(self):
        # Phase 4 benchmark: a big-number with no number drew "0"; "subtitle" was rejected without saying "sub".
        p = project(); p["beats"][0] = {"id": "n", "kind": "big-number", "bars": 1, "text": "players"}
        self.bad(p, "beats[0].number")
        p["beats"][0]["number"] = "312"
        video_store.validate(p)
        p["beats"][0]["subtitle"] = "last fall"
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn("use sub", str(caught.exception))

    def test_defaults_and_copy(self):
        p = project()
        for key in ("bpm", "fps", "aspects", "music"):
            p.pop(key)
        out = video_store.validate(p)
        self.assertEqual((out["bpm"], out["fps"], out["aspects"]), (120, 30, ["16:9"]))
        out["beats"][0]["text"] = "changed"
        self.assertEqual(p["beats"][0]["text"], "Start here")

    def test_project_fields(self):
        cases = [("id", "../x"), ("id", 1), ("title", ""), ("title", "a" * 121), ("title", None),
                 ("look", ""), ("look", "../sport"), ("look", 4), ("fps", 60), ("fps", True),
                 ("bpm", 59), ("bpm", 181), ("bpm", True), ("bpm", float("nan")), ("bpm", "120"),
                 ("aspects", []), ("aspects", "16:9"), ("aspects", ["4:3"]), ("aspects", ["16:9", "16:9"]),
                 ("aspects", [{}]), ("beats", []), ("beats", {}), ("beats", [None]), ("music", None)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.bad(project(**{field: value}), "beats[0]" if field == "beats" and value == [None] else field)
        self.bad(project(extra=True), "extra")
        self.bad(project(beats=project()["beats"] * 21), "beats")

    def test_beat_fields(self):
        cases = [("id", ""), ("id", "../"), ("id", 1), ("kind", "scene"), ("kind", None),
                 ("bars", .25), ("bars", 8.5), ("bars", .75), ("bars", True), ("bars", float("inf")),
                 ("text", "x" * 141), ("text", 3), ("sub", "x" * 101), ("items", ["x"] * 6),
                 ("items", "x"), ("items", ["x" * 61]), ("items", [3]), ("image", "https://x"),
                 ("image", "assets/../secret.png"), ("image", 1), ("number", float("nan")), ("number", True),
                 ("number", "x" * 141), ("camera", "drift"), ("transition", "fade"), ("treatment", 3)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                p = project()
                p["beats"][0][field] = value
                path = f"beats[0].{field}" + ("[0]" if field == "items" and isinstance(value, list) and len(value) == 1 else "")
                self.bad(p, path)
        p = project()
        p["beats"][1]["id"] = "hook"
        self.bad(p, "beats[1].id")
        p["beats"][0]["extra"] = 1
        self.bad(p, "beats[0].extra")

    def test_music_rules(self):
        for value, path in [({}, "music.mood"), ({"mood": "sad", "volume": .7}, "music.mood"),
                            ({"mood": "warm", "volume": -1}, "music.volume"),
                            ({"mood": "warm", "volume": 2}, "music.volume"),
                            ({"mood": "warm", "volume": True}, "music.volume"),
                            ({"mood": "warm", "volume": float("inf")}, "music.volume"),
                            ({"mood": "warm", "volume": .7, "file": "x"}, "music.file")]:
            self.bad(project(music=value), path)

    def test_every_vocabulary_and_boundaries(self):
        for kind in video_store.KINDS:
            for camera in video_store.CAMERAS:
                p = project()
                p["beats"][0].update(kind=kind, camera=camera, items=["x" * 60] * 5, text="x" * 140,
                                      sub="x" * 100, number="42%", image="assets/" + "a" * 64 + ".png")
                for transition in video_store.TRANSITIONS:
                    p["beats"][0]["transition"] = transition
                    video_store.validate(p)
        video_store.validate(project(aspects=list(video_store.ASPECTS), bpm=60))
        video_store.validate(project(bpm=180))

    def test_duration_and_maximum(self):
        self.assertEqual(video_store.duration(project()), 4)
        p = project(bpm=60, beats=[{"id": f"b{i}", "kind": "title", "bars": 1} for i in range(30)])
        self.assertEqual(video_store.duration(video_store.validate(p)), 120)
        p["beats"][0]["bars"] = 1.5
        self.bad(p, "beats")
        self.assertAlmostEqual(video_store.duration(project(bpm=180)), 8 / 3)

    def test_frame_count_tolerates_accumulated_float_rounding(self):
        p = project(bpm=150, beats=[{"id": f"b{i}", "kind": "title", "bars": .5} for i in range(6)])
        p["version"] = 1
        self.assertEqual(video_render._job(p, "16:9", "rounding")["frames"], 144)
        self.assertEqual(math.ceil(sum(.8 for _ in range(6)) * 30 - 1e-7), 144)


class StoreTests(unittest.TestCase):
    def test_create_save_history_restore(self):
        p = make()
        self.assertRegex(p["id"], r"^[a-f0-9]{12}$")
        p["title"] = "Changed"
        saved = video_store.save(p["id"], p)
        self.assertEqual(saved["version"], 2)
        self.assertEqual(video_store.history(p["id"])[1]["title"], "A short story")
        restored = video_store.restore(p["id"], 1)
        self.assertEqual(restored["version"], 3)
        self.assertEqual(restored["title"], "A short story")
        with self.assertRaises(LookupError):
            video_store.restore(p["id"], 1000)

    def test_history_retains_thirty(self):
        p = make()
        for i in range(35):
            p["title"] = str(i)
            p = video_store.save(p["id"], p)
        self.assertEqual(len(video_store.history(p["id"])), 30)
        self.assertEqual(video_store.history(p["id"])[0]["version"], 36)
        with self.assertRaises(LookupError):
            video_store.restore(p["id"], 1)

    def test_save_failure_and_metadata_immutable(self):
        p = make()
        original = video_store.get(p["id"])
        bad = copy.deepcopy(p)
        bad["beats"][0]["bars"] = .75
        with self.assertRaises(ValueError):
            video_store.save(p["id"], bad)
        self.assertEqual(video_store.get(p["id"]), original)
        p.update(owner="mallory", chat_ids=["evil"], visible_to=["mallory"], version=500)
        saved = video_store.save(p["id"], p)
        self.assertEqual(saved["owner"], "alice")
        self.assertEqual(saved["chat_ids"], ["chat-alice"])
        self.assertEqual(saved["version"], 2)

    def test_ownership_chat_links_and_delete(self):
        p = make()
        ident = p["id"]
        self.assertTrue(video_store.visible_to(p, "alice", False))
        self.assertFalse(video_store.visible_to(p, "bob", False))
        self.assertTrue(video_store.visible_to(p, "admin", True))
        self.assertIn(ident, [v["id"] for v in video_store.list_for_user("alice")])
        self.assertNotIn(ident, [v["id"] for v in video_store.list_for_user("bob")])
        with self.assertRaises(LookupError):
            video_store.require_user_access(ident, "bob")
        with self.assertRaises(PermissionError):
            video_store.require_chat_access(ident, "chat-bob")
        video_store.link_chat(ident, "chat-bob")
        self.assertEqual(video_store.require_chat_access(ident, "chat-bob")["id"], ident)
        self.assertIn(ident, [v["id"] for v in video_store.videos_for_chat("chat-bob")])
        self.assertEqual(video_store.chat_key(None, "agent"), "agent:agent")
        video_store.delete(ident)
        with self.assertRaises(LookupError):
            video_store.get(ident)
        with self.assertRaises(LookupError):
            video_store.get("../secret")

    def test_asset_dedup_copy_and_isolation(self):
        p = make()
        raw = image("PNG")
        asset = video_store.add_asset(p["id"], raw, "png")
        self.assertEqual(asset, video_store.add_asset(p["id"], raw, "png"))
        self.assertEqual(video_store.asset_path(p["id"], asset[7:]).read_bytes(), raw)
        design, _ = design_store.create("Photos", owner="alice", chat_key_="chat-alice", by="test", design_system="sport")
        source = design_store.add_asset(design["id"], raw, "png")
        self.assertEqual(video_store.add_asset(p["id"], design_id=design["id"], asset=source, user="alice"), asset)
        self.assertEqual(video_store.add_asset(p["id"], design_id=design["id"], asset=source, key="chat-alice"), asset)
        with self.assertRaises(LookupError):
            video_store.add_asset(p["id"], design_id=design["id"], asset=source, user="bob")
        with self.assertRaises(PermissionError):
            video_store.add_asset(p["id"], design_id=design["id"], asset=source, key="chat-bob")
        with self.assertRaises(ValueError):
            video_store.add_asset(p["id"], b"not a picture", "png")
        with self.assertRaises(LookupError):
            video_store.asset_path(p["id"], "../project.json")


class AudioTests(unittest.TestCase):
    def test_deterministic_length_fades_peak_and_stereo(self):
        p = project()
        p["beats"][1]["transition"] = "whip"
        a, b = Path(fixture.name) / "a.wav", Path(fixture.name) / "b.wav"
        video_audio.write_wav(a, p)
        video_audio.write_wav(b, p)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        with wave.open(str(a)) as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (48000, 2, 2))
            self.assertEqual(wav.getnframes(), round(video_store.duration(p) * 48000))
            pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, 2) / 32768
        self.assertLess(np.max(np.abs(pcm[0])), .01)
        self.assertLess(np.max(np.abs(pcm)), 1)
        self.assertLess(np.max(np.abs(pcm[-480:])), .03)
        self.assertFalse(np.array_equal(pcm[:, 0], pcm[:, 1]))

    def test_mood_presets_differ_and_silent_volume(self):
        rendered = []
        for mood in video_store.MOODS:
            samples = video_audio.synthesize(project(music={"mood": mood, "volume": .7}))
            rendered.append(samples.tobytes())
            self.assertTrue(np.isfinite(samples).all())
            self.assertGreater(np.max(np.abs(samples)), .1)
        self.assertEqual(len(set(rendered)), 5)
        self.assertEqual(np.max(np.abs(video_audio.synthesize(project(music={"mood": "calm", "volume": 0})))), 0)

    def test_non_cut_transition_adds_one_shot(self):
        p = project()
        cut = video_audio.synthesize(p)
        p["beats"][1]["transition"] = "zoom"
        self.assertNotEqual(cut.tobytes(), video_audio.synthesize(p).tobytes())

class FFmpegTests(unittest.TestCase):
    def test_find_configured_then_path(self):
        with patch.object(settings, "get_setting", return_value="configured"), patch.object(ffmpeg_tools, "_runnable", return_value=True), patch.object(ffmpeg_tools.shutil, "which", return_value="on-path") as which:
            self.assertEqual(ffmpeg_tools.find(), "configured")
            which.assert_not_called()
        with patch.object(settings, "get_setting", return_value="bad"), patch.object(ffmpeg_tools, "_runnable", return_value=False), patch.object(ffmpeg_tools.shutil, "which", return_value="on-path"):
            self.assertEqual(ffmpeg_tools.find(), "on-path")

    def test_find_winget_link_package_missing(self):
        local = Path(fixture.name) / "local-app"
        root = local / "Microsoft" / "WinGet"
        link = root / "Links" / "ffmpeg.exe"
        package = root / "Packages" / "Gyan.FFmpeg_test" / "release" / "bin" / "ffmpeg.exe"
        link.parent.mkdir(parents=True, exist_ok=True)
        package.parent.mkdir(parents=True, exist_ok=True)
        link.write_bytes(b"test")
        package.write_bytes(b"test")
        with patch.dict(os.environ, {"LOCALAPPDATA": str(local)}), patch.object(settings, "get_setting", return_value=None), patch.object(ffmpeg_tools.shutil, "which", return_value=None), patch.object(ffmpeg_tools, "_runnable", return_value=True):
            self.assertEqual(ffmpeg_tools.find(), str(link))
            link.unlink()
            self.assertEqual(ffmpeg_tools.find(), str(package))
            package.unlink()
            self.assertIsNone(ffmpeg_tools.find())

    def test_runnable_failures_and_version(self):
        with patch.object(ffmpeg_tools.subprocess, "run", side_effect=OSError):
            self.assertFalse(ffmpeg_tools._runnable("bad"))
        with patch.object(ffmpeg_tools, "find", return_value=None):
            self.assertIsNone(ffmpeg_tools.version())
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools.subprocess, "run", return_value=MagicMock(returncode=0, stdout=b"ffmpeg version test\nother")):
            self.assertEqual(ffmpeg_tools.version(), "ffmpeg version test")

    def test_encoder_exact_argv_and_no_shell(self):
        with patch.object(ffmpeg_tools.subprocess, "Popen") as popen:
            process = popen.return_value
            process.wait.return_value = 0
            enc = ffmpeg_tools.Encoder("out.mp4", "soundtrack.wav", executable="ffmpeg")
            expected = ["ffmpeg", "-y", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "-", "-i", "soundtrack.wav", "-vf", "scale=out_range=tv:out_color_matrix=bt709", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-shortest", "-movflags", "+faststart", "out.mp4"]
            self.assertEqual(popen.call_args.args[0], expected)
            self.assertIs(popen.call_args.kwargs["shell"], False)
            frame = image()
            enc.write(frame)
            process.stdin.write.assert_called_once_with(frame)
            self.assertEqual(enc.finish(), Path("out.mp4"))
            process.wait.assert_called_once_with(timeout=180)

    def test_encoder_errors_timeout_and_cleanup(self):
        with patch.object(ffmpeg_tools.subprocess, "Popen") as popen:
            process = popen.return_value
            process.wait.return_value = 2
            enc = ffmpeg_tools.Encoder("out.mp4", "soundtrack.wav", executable="ffmpeg")
            enc.stderr.write(b"useful encode failure")
            with self.assertRaisesRegex(RuntimeError, "useful encode failure"):
                enc.finish()
            enc = ffmpeg_tools.Encoder("out.mp4", "soundtrack.wav", executable="ffmpeg")
            process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 1), 0]
            with self.assertRaisesRegex(RuntimeError, "too long"):
                enc.finish()
            process.kill.assert_called()
        with patch.object(ffmpeg_tools, "find", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Kairos never installs"):
                ffmpeg_tools.Encoder("out.mp4", "soundtrack.wav")

    def test_loudness_parser(self):
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools.subprocess, "run", return_value=MagicMock(returncode=0, stderr=b'noise\n{"input_i":"-16.2", "input_tp":"-1.4"}\n')):
            self.assertEqual(ffmpeg_tools.loudness("out.mp4"), {"input_i": -16.2, "input_tp": -1.4})
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools.subprocess, "run", return_value=MagicMock(returncode=0, stderr=b"bad")):
            with self.assertRaisesRegex(RuntimeError, "measure loudness"):
                ffmpeg_tools.loudness("out.mp4")

    def test_sheet(self):
        sheet = ffmpeg_tools.contact_sheet([image()] * 6, 3)
        self.assertTrue(sheet.startswith(b"\x89PNG"))
        with Image.open(io.BytesIO(sheet)) as im:
            self.assertEqual(im.size, (976, 372))

    def test_real_one_second_encode_if_available(self):
        exe = ffmpeg_tools.find()
        if not exe:
            self.skipTest("FFmpeg is not installed; discovery and argv tested above.")
        p = project(beats=[{"id": "one", "kind": "title", "bars": .5}])
        wav, mp4 = Path(fixture.name) / "one.wav", Path(fixture.name) / "one.mp4"
        video_audio.write_wav(wav, p)
        encoder = ffmpeg_tools.Encoder(mp4, wav, executable=exe)
        try:
            for i in range(30):
                encoder.write(image())
            encoder.finish()
        except BaseException:
            encoder.abort()
            raise
        self.assertGreater(mp4.stat().st_size, 1000)
        self.assertIn(b"ftyp", mp4.read_bytes()[:32])
        measured = ffmpeg_tools.loudness(mp4)
        self.assertTrue(all(math.isfinite(v) for v in measured.values()))


class CheckTests(unittest.TestCase):
    def box(self, **changes):
        return {"beat": "hook", "kind": "text", "text": "Start here", "x": 200, "y": 200, "w": 500, "h": 100,
                "color": "#ffffff", "bg": "#000000", **changes}

    def test_quiet_good_data(self):
        notes = video_checks.check(project(), layouts=[{"time": 1, "elements": [self.box()]}], frames=[image()], loudness={"input_i": -16, "input_tp": -1.5})
        self.assertEqual(notes, [])

    def test_safe_area_and_contrast(self):
        notes = video_checks.check(project(), layouts=[{"elements": [self.box(x=0, color="#888", bg="#999")]}] * 2)
        self.assertEqual(sum("safe area" in n for n in notes), 1)
        self.assertEqual(sum("contrast" in n for n in notes), 1)
        for y in (120, 1660):
            notes = video_checks.check(project(), "9:16", layouts=[{"elements": [self.box(y=y, h=80)]}])
            self.assertTrue(any("safe area" in n for n in notes))

    def test_reading_and_short_beat_and_ending(self):
        p = project(bpm=180)
        p["beats"][0].update(bars=.5, text="Too many words all at once on this screen")
        p["beats"][1]["bars"] = .5
        notes = video_checks.check(p)
        for text in ("3.5 words/s", "under 1 second", "under 1.5 seconds"):
            self.assertTrue(any(text in note for note in notes))

    def test_layout_reading_time_and_blank_and_loudness(self):
        notes = video_checks.check(project(), layouts=[{"elements": [self.box(text="word " * 20)]}], frames=[image(blank=True)], loudness={"input_i": -20, "input_tp": -.2})
        for text in ("3.5 words/s", "near-blank", "loudness", "true peak"):
            self.assertTrue(any(text in note for note in notes))


class ToolTests(unittest.TestCase):
    def setUp(self):
        session = session_manager.create_session(owner_user="alice")
        self.ctx = tool_registry.ToolContext(session_id=session["id"], surface=tool_registry.CODEX, turn_taint=TurnTaint())

    def call(self, name, args):
        return run(tool_registry._REGISTRY[name].handler(args, self.ctx))

    def create(self):
        self.call("video_create", {"title": "Test", "look": "sport", "beats": project()["beats"]})
        return video_store.videos_for_chat(self.ctx.session_id)[0]

    def test_create_outline_and_direction(self):
        reply = self.call("video_create", {"title": "Test", "look": "sport", "beats": project()["beats"]})
        p = video_store.videos_for_chat(self.ctx.session_id)[0]
        self.assertIn(f"[Video: Test](/videos/{p['id']})", reply)
        self.assertIn("4s", reply)
        self.assertIn("hook", self.call("video_outline", {}))
        self.assertIn("video", creative_direction.KINDS)
        self.assertTrue(creative_direction.directions("A product launch video", "video", owner="alice"))
        self.assertIn("Pick a look first", self.call("video_create", {"title": "Test", "beats": project()["beats"]}))

    def test_all_edit_operations(self):
        p = self.create()
        reply = self.call("video_edit", {"ops": [{"op": "set", "id": "hook", "field": "text", "value": "Changed"},
                  {"op": "insert", "after": "hook", "beat": {"id": "proof", "kind": "big-number", "bars": 1, "number": "42%"}},
                  {"op": "move", "id": "proof", "before": "hook"}, {"op": "project", "field": "bpm", "value": 100},
                  {"op": "remove", "id": "end"}]})
        saved = video_store.get(p["id"])
        self.assertEqual([b["id"] for b in saved["beats"]], ["proof", "hook"])
        self.assertEqual(saved["beats"][1]["text"], "Changed")
        self.assertEqual(saved["bpm"], 100)
        self.assertIn("version 2", reply)

    def test_invalid_edits_are_atomic(self):
        p = self.create()
        for bad in [{"op": "remove", "id": "missing"}, {"op": "set", "id": "end", "field": "bars", "value": .75},
                    {"op": "move", "id": "hook", "after": "hook"}, {"op": "project", "field": "owner", "value": "evil"},
                    {"op": "insert", "before": "end", "after": "hook", "beat": {}}, {"op": "explode"},
                    {"op": "project", "field": "look", "value": "missing"}]:
            reply = self.call("video_edit", {"ops": [{"op": "set", "id": "hook", "field": "text", "value": "partial"}, bad]})
            self.assertIn("Not run", reply)
            self.assertEqual(video_store.get(p["id"]), p)

    def test_gating_and_surfaces(self):
        names = {s["function"]["name"] for s in tool_registry.openai_tools(session_id=self.ctx.session_id)}
        # A large window lists every video tool from the start: a turn's tool list is fixed before
        # video_create links the video (the Phase 3 image benchmark lesson). A small window waits.
        self.assertTrue(video_tools.LINKED_TOOLS | {"video_create"} <= names)
        small = {s["function"]["name"] for s in tool_registry.openai_tools(session_id=self.ctx.session_id, small_window=True)}
        self.assertFalse(small & (video_tools.LINKED_TOOLS | {"video_create"}))
        self.assertFalse(tool_registry._shown(tool_registry._REGISTRY["video_create"], True, self.ctx.session_id))
        self.create()
        self.assertTrue(tool_registry.design_gate(tool_registry._REGISTRY["video_outline"], self.ctx.session_id))
        self.assertTrue(tool_registry._shown(tool_registry._REGISTRY["video_create"], True, self.ctx.session_id))
        for name in video_tools.LINKED_TOOLS | {"video_create"}:
            self.assertEqual(tool_registry._REGISTRY[name].surfaces, tool_registry.ALL)

    def test_access_multiple_projects_and_no_chat(self):
        self.create()
        self.assertIn("cannot change", self.call("video_outline", {"video_id": make()["id"]}))
        self.create()
        self.assertIn("several videos", self.call("video_outline", {}))
        self.assertIn("belong", run(video_tools._read({}, tool_registry.ToolContext())))

    def test_preview_image_and_missing_desktop(self):
        self.create()
        with patch.object(video_render, "preview", new=AsyncMock(return_value=[image()] * 2)):
            result = self.call("video_preview", {})
            self.assertIsInstance(result, tool_registry.ToolResult)
            self.assertTrue(result.images[0].startswith(b"\x89PNG"))
        with patch.object(bridge, "available", return_value=False):
            self.assertIn("desktop app", self.call("video_preview", {}))

    def test_copy_image_through_tool(self):
        p = self.create()
        design, _ = design_store.create("Photos", owner="alice", chat_key_=self.ctx.session_id,
                                        by="test", design_system="sport")
        asset = design_store.add_asset(design["id"], image("PNG"), "png")
        reply = self.call("video_add_image", {"source": {"design_id": design["id"], "asset": asset}})
        self.assertIn(asset, reply)
        self.assertTrue(video_store.asset_path(p["id"], asset[7:]).is_file())

    def test_render_publishes_real_download_and_failure(self):
        self.create()
        async def ready():
            pass
        def start(ident, aspect):
            video_render._tasks["tool-render"] = asyncio.create_task(ready())
            return {"id": "tool-render"}
        status = {"status": "ready", "path": "render.mp4", "loudness": {"input_i": -16, "input_tp": -1.5}, "notes": ["Review the sheet."]}
        with patch.object(video_render, "start", side_effect=start), patch.object(video_render, "status", return_value=status), patch.object(video_tools.image_gen, "register_generated_file", return_value={"filename": "video.mp4", "url": "/generated-files/video.mp4"}) as publish:
            reply = self.call("video_render", {})
            self.assertIn("[video.mp4](/generated-files/video.mp4)", reply)
            self.assertIn("tool-render", reply)
            self.assertIn("Review the sheet", reply)
            publish.assert_called_once_with("render.mp4")
        with patch.object(ffmpeg_tools, "find", return_value=None):
            self.assertIn(ffmpeg_tools.MISSING, self.call("video_render", {}))

class RouteTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(video_routes.router)
        self.app.include_router(design_routes.render_router)
        self.app.dependency_overrides[require_user] = lambda: "alice"
        self.client = TestClient(self.app)

    def create(self):
        p = project()
        p.pop("id")
        response = self.client.post("/api/videos", json=p)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_crud_history_restore_and_input(self):
        p = self.create()
        root = f"/api/videos/{p['id']}"
        self.assertEqual(self.client.get(root).json()["title"], p["title"])
        self.assertTrue(any(v["id"] == p["id"] for v in self.client.get("/api/videos").json()))
        p["title"] = "New"
        self.assertEqual(self.client.put(root, json=p).json()["version"], 2)
        self.assertEqual(len(self.client.get(root + "/history").json()), 2)
        self.assertEqual(self.client.post(root + "/restore/1").json()["title"], "A short story")
        # A save made from an older version is refused, and the video is unchanged.
        stale = self.client.put(root, json={**p, "title": "Stale"})
        self.assertEqual(stale.status_code, 409)
        self.assertIn("changed since you opened it", stale.text)
        self.assertEqual(self.client.get(root).json()["title"], "A short story")
        p = self.client.get(root).json()
        p["beats"][0]["bars"] = .75
        response = self.client.put(root, json=p)
        self.assertEqual(response.status_code, 422)
        self.assertIn("beats[0].bars", response.text)
        self.assertEqual(self.client.delete(root).status_code, 200)
        self.assertEqual(self.client.get(root).status_code, 404)

    def test_auth_and_owner_and_metadata(self):
        p = self.create()
        root = f"/api/videos/{p['id']}"
        self.app.dependency_overrides[require_user] = lambda: "bob"
        with patch.object(video_routes.auth_manager, "is_admin", return_value=False):
            for response in (self.client.get(root), self.client.delete(root), self.client.put(root, json=p)):
                self.assertEqual(response.status_code, 404)
        self.app.dependency_overrides.clear()
        with patch.object(middleware, "get_current_user", return_value=None):
            self.assertEqual(self.client.get("/api/videos").status_code, 401)

    def test_player_injection_escaping_csp_and_signatures(self):
        p = self.create()
        p["beats"][0]["text"] = "</script><script>evil()</script>"
        p = video_store.save(p["id"], p)
        template = '<html><head><!--KD-TOKENS--><!--KD-PROJECT--></head><body><canvas id="kd-canvas"></canvas><script type="module" src="engine.js"></script></body></html>'
        with patch.object(video_routes.Path, "is_file", return_value=True), patch.object(video_routes.Path, "read_text", return_value=template), patch.object(video_routes, "get_current_user", return_value="alice"):
            response = self.client.get(f"/api/videos/{p['id']}/player")
            self.assertEqual(response.status_code, 200)
            self.assertIn('id="kd-project"', response.text)
            self.assertIn("<\\/script>", response.text)
            self.assertNotIn("</script><script>evil", response.text)
            self.assertIn("--ds-bg", response.text)
            self.assertIn("@font-face", response.text)
            self.assertIn('/static/motion/engine.js', response.text)
            self.assertIn("connect-src 'none'", response.headers["Content-Security-Policy"])
            token = design_render.sign(p["id"], f"video:16:9:{p['version']}")
            signed = f"/api/videos/{p['id']}/player?aspect=16%3A9&rt={token}&v={p['version']}"
            with patch.object(video_routes, "get_current_user", return_value=None):
                self.assertEqual(self.client.get(signed).status_code, 200)
                self.assertEqual(self.client.get(signed.replace("16%3A9", "1%3A1")).status_code, 404)
                self.assertEqual(self.client.get(f"/api/videos/{p['id']}/player").status_code, 401)

    def test_assets_download_and_copy(self):
        p = self.create()
        root = f"/api/videos/{p['id']}"
        response = self.client.post(root + "/assets", files={"file": ("photo.png", image("PNG"), "image/png")})
        self.assertEqual(response.status_code, 200, response.text)
        asset = response.json()["asset"]
        self.assertEqual(self.client.get(root + "/" + asset).content, image("PNG"))
        design, _ = design_store.create("Photos", owner="alice", chat_key_="chat-alice", by="test", design_system="sport")
        source = design_store.add_asset(design["id"], image("PNG"), "png")
        response = self.client.post(root + "/assets", json={"design_id": design["id"], "asset": source})
        self.assertEqual(response.json()["asset"], asset)
        self.assertEqual(self.client.get(root + "/renders/invalid.txt").status_code, 404)
        wav = video_store._folder(p["id"]) / "renders" / "soundtrack.wav"
        wav.write_bytes(b"RIFFtest")
        self.assertEqual(self.client.get(root + "/renders/soundtrack.wav").content, b"RIFFtest")

    def test_player_policy_survives_global_headers(self):
        p = make()
        app = FastAPI()
        app.include_router(video_routes.router)
        app.add_middleware(SecurityHeadersMiddleware)
        with patch.object(middleware, "_OWN_POLICY_PATHS", middleware._OWN_POLICY_PATHS + (video_routes.PLAYER_PATH,)), patch.object(video_routes, "get_current_user", return_value="alice"), patch.object(video_routes, "player_page", return_value="<html></html>"):
            response = TestClient(app).get(f"/api/videos/{p['id']}/player")
        self.assertEqual(response.status_code, 200)
        self.assertIn("connect-src 'none'", response.headers["Content-Security-Policy"])
        self.assertIn("script-src http://testserver/static/motion/", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Frame-Options"], "SAMEORIGIN")

    def test_missing_ffmpeg_and_desktop(self):
        p = self.create()
        with patch.object(ffmpeg_tools, "find", return_value=None):
            response = self.client.post(f"/api/videos/{p['id']}/render", json={"aspect": "16:9"})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"], ffmpeg_tools.MISSING)
            self.assertEqual(self.client.get("/api/videos/ffmpeg").json()["message"], ffmpeg_tools.MISSING)
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(bridge, "available", return_value=False):
            self.assertIn("desktop app", self.client.post(f"/api/videos/{p['id']}/render", json={"aspect": "16:9"}).text)

    def test_job_auth_and_cancel(self):
        p = self.create()
        video_render._jobs["test-job"] = {"id": "test-job", "video_id": p["id"], "status": "queued", "path": "private"}
        self.assertNotIn("path", self.client.get("/api/video-jobs/test-job").json())
        self.assertEqual(self.client.post("/api/video-jobs/test-job/cancel").status_code, 200)
        self.app.dependency_overrides[require_user] = lambda: "bob"
        with patch.object(video_routes.auth_manager, "is_admin", return_value=False):
            self.assertEqual(self.client.get("/api/video-jobs/test-job").status_code, 404)
            self.assertEqual(self.client.post("/api/video-jobs/test-job/cancel").status_code, 404)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        bridge._queue = None
        bridge._pending.clear()
        bridge._video_parts.clear()
        self.stream = bridge.worker_stream()
        await anext(self.stream)

    async def asyncTearDown(self):
        await self.stream.aclose()
        bridge._queue = None

    async def test_queue_parts_assemble_and_final(self):
        received, layouts = [], []
        async def consume(frames, samples):
            received.extend(frames)
            layouts.extend(samples)
        p = make()
        job = video_render._job(p, "16:9", "parts", [1, 3])
        task = asyncio.create_task(bridge.video(job, consume))
        packet = json.loads((await anext(self.stream)).split("data: ")[1])
        self.assertEqual(packet["kind"], "video")
        self.assertEqual(packet["fps"], 30)
        self.assertEqual(packet["w"], 1920)
        self.assertEqual(len(packet["layoutTimes"]), 6)
        self.assertIn("&v=1", packet["path"])
        raw = image()
        samples = [{"time": 1, "elements": []}]
        for part in range(2):
            self.assertTrue(await bridge.complete_video("parts", json.dumps({"frames": [base64.b64encode(raw).decode()], "layouts": samples if part == 0 else []}).encode(), part))
            self.assertFalse(task.done())
        self.assertTrue(await bridge.complete_video("parts", b'{"frames":2}'))
        self.assertEqual((await task)["frames"], 2)
        self.assertEqual(received, [raw, raw])
        self.assertEqual(layouts, samples)
        self.assertFalse(await bridge.complete_video("parts", b'{"frames":2}'))

    async def test_out_of_order_and_truncation_fail(self):
        for suffix, payload, part in [("order", b'{"frames":[]}', 1), ("short", b'{"frames":1}', None),
                                      ("invalid", b'{"frames":["notbase64"]}', 0)]:
            async def consume(frames, layouts):
                self.fail("Invalid data reached consumer")
            task = asyncio.create_task(bridge.video(video_render._job(make(), "16:9", suffix, [1]), consume))
            while True:
                packet = json.loads((await anext(self.stream)).split("data: ")[1])
                if packet["kind"] != "cancel":
                    break
            self.assertFalse(await bridge.complete_video(suffix, payload, part))
            with self.assertRaises(RuntimeError):
                await task

    async def test_cancel_emits_control(self):
        p = make()
        task = asyncio.create_task(video_render.preview(p["id"], "16:9", [1]))
        packet = json.loads((await anext(self.stream)).split("data: ")[1])
        self.assertTrue(packet["preview"])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        cancel = json.loads((await anext(self.stream)).split("data: ")[1])
        self.assertEqual(cancel, {"id": packet["id"], "kind": "cancel"})

    async def test_preview_assembles_without_ffmpeg(self):
        p = make()
        with patch.object(ffmpeg_tools, "find", side_effect=AssertionError("Preview must not need FFmpeg")):
            task = asyncio.create_task(video_render.preview(p["id"], "16:9", [1, 3]))
            packet = json.loads((await anext(self.stream)).split("data: ")[1])
            raw = image()
            body = json.dumps({"frames": [base64.b64encode(raw).decode()] * 2, "layouts": []}).encode()
            self.assertTrue(await bridge.complete_video(packet["id"], body, 0))
            self.assertTrue(await bridge.complete_video(packet["id"], b'{"frames":2}'))
            self.assertEqual(await task, [raw, raw])
            self.assertIn(p["id"], video_render._last_preview)

    async def test_result_route_parts_and_worker_auth(self):
        import httpx
        app = FastAPI()
        app.include_router(design_routes.render_router)
        received = []
        async def consume(frames, samples):
            received.extend(frames)
        task = asyncio.create_task(bridge.video(video_render._job(make(), "16:9", "http-part", [1]), consume))
        await anext(self.stream)
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
        body = {"frames": [base64.b64encode(image()).decode()], "layouts": []}
        with patch.object(bridge, "TOKEN", "test-render-secret"):
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                path = "/api/design-render/result/http-part"
                self.assertEqual((await client.post(path + "?part=0", json=body)).status_code, 404)
                headers = {"X-Kairos-Render-Token": "test-render-secret"}
                reply = await client.post(path + "?part=0", json=body, headers=headers)
                self.assertEqual(reply.json(), {"ok": True})
                self.assertEqual((await client.post(path, json={"frames": 1}, headers=headers)).json(), {"ok": True})
        self.assertEqual(await task, {"frames": 1})
        self.assertEqual(received, [image()])

    async def test_machine_queue_and_cancel_before_encoding(self):
        p = make()
        entered = asyncio.Event()
        calls = []
        async def capture(job, consumer):
            calls.append(job["id"])
            entered.set()
            await asyncio.Future()
        class Encoder:
            def __init__(self, path, wav):
                self.path = path
                self.path.write_bytes(b"partial")
            def abort(self):
                self.path.unlink(missing_ok=True)
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools, "Encoder", Encoder), patch.object(video_render.video_audio, "write_wav"), patch.object(bridge, "video", side_effect=capture):
            first = video_render.start(p["id"], "16:9")
            await asyncio.wait_for(entered.wait(), 2)
            second = video_render.start(p["id"], "16:9")
            await asyncio.sleep(0)
            self.assertEqual(video_render.status(second["id"])["status"], "queued")
            self.assertEqual(len(calls), 1)
            entered.clear()
            video_render.cancel(first["id"])
            await video_render._tasks[first["id"]]
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual(len(calls), 2)
            video_render.cancel(second["id"])
            await video_render._tasks[second["id"]]
            self.assertTrue(video_render.status(first["id"])["status"].startswith("failed: cancelled"))
            self.assertEqual(list((video_store._folder(p["id"]) / "renders").glob("*.partial.mp4")), [])

    async def test_full_render_sink(self):
        p = make()
        p["beats"] = [{"id": "one", "kind": "title", "bars": .5, "text": "Go"}]
        p = video_store.save(p["id"], p)
        class Encoder:
            def __init__(self, path, wav):
                self.path = path
                self.count = 0
                self.path.write_bytes(b"mp4")
            def write(self, raw):
                self.count += 1
            def finish(self):
                return self.path
            def abort(self):
                self.path.unlink(missing_ok=True)
        async def worker():
            packet = json.loads((await anext(self.stream)).split("data: ")[1])
            total = packet["frames"]
            for part, offset in enumerate(range(0, total, 15)):
                raw = json.dumps({"frames": [base64.b64encode(image()).decode()] * min(15, total - offset), "layouts": []}).encode()
                self.assertTrue(await bridge.complete_video(packet["id"], raw, part))
            self.assertTrue(await bridge.complete_video(packet["id"], json.dumps({"frames": total}).encode()))
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools, "Encoder", Encoder), patch.object(ffmpeg_tools, "loudness", return_value={"input_i": -16, "input_tp": -1.5}):
            work = asyncio.create_task(worker())
            result = await video_render.render(p["id"], "16:9")
            await work
            self.assertEqual(result["status"], "ready", result)
            self.assertTrue(Path(result["path"]).is_file())
            folder = video_store._folder(p["id"]) / "renders"
            for name in ("sheet-16-9.png", "thumb-16-9.png", "soundtrack.wav"):
                self.assertTrue((folder / name).is_file())


class WorkerStaticTests(unittest.TestCase):
    def test_allowlist_and_protection_with_node_stub(self):
        source = r'''
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { require: () => ({}), module: { exports: {} }, URL };
vm.runInNewContext(fs.readFileSync('electron/designRender.js', 'utf8'), sandbox);
const { allowedRequest, VIDEO_PATH } = sandbox.module.exports;
const id = '012345abcdef', origin = 'http://localhost:9999';
const path = `/api/videos/${id}/player?aspect=16%3A9&rt=1999999999.AAAAAAAAAAAAAAAAAAAAAAAA&v=1`;
assert(VIDEO_PATH.test(path));
const ok = value => allowedRequest(origin + value, origin, '', id, path, 'sport');
assert(ok(path)); assert(ok('/static/motion/engine.js')); assert(ok('/api/design-fonts/sport/test.ttf'));
assert(ok(`/api/videos/${id}/assets/${'a'.repeat(64)}.png`));
for (const bad of ['/api/settings', '/static/js/app.js', '/api/design-fonts/other/test.ttf', `/api/videos/${id}/project.json`, '/static/motion/player.html']) assert(!ok(bad), bad);
assert(!allowedRequest('https://example.com/static/motion/engine.js', origin, '', id, path, 'sport'));
'''
        subprocess.run(["node", "-e", source], cwd=ROOT, check=True, capture_output=True)
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        for protection in ("sandbox: true", "contextIsolation: true", "nodeIntegration: false", "callback(false)", "will-navigate", "will-download", "action: 'deny'", "stopped || win.isDestroyed()", "frames.length === 15", "toDataURL('image/jpeg', 0.92)"):
            self.assertIn(protection, worker)

    def test_prompt_and_skill_versions_and_lf(self):
        from core import system_prompt
        self.assertIn("To make a video, pick a look with creative_direction, then video_create with a beat sheet, video_preview, and video_render.", system_prompt.DESIGN_CANVAS_LINE)
        raw = (ROOT / "skill_templates/motion-video/SKILL.md").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b'version: "2.0.0"', raw)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        fixture.cleanup()
