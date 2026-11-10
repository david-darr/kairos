"""Video contracts without Electron or network; optional real FFmpeg encode."""
import asyncio
import base64
import copy
import io
import json
import math
import os
import re
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
from core import (creative_direction, design_render, design_render_bridge as bridge, design_store, design_systems,
                  ffmpeg_tools, settings, tool_registry, video_audio, video_checks, video_narration, video_render,
                  video_store, video_tools)
from core.middleware import SecurityHeadersMiddleware, require_user
from core import accounts, middleware
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
        cases = [("id", ""), ("id", "../"), ("id", 1), ("kind", "panel"), ("kind", None),
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
                if kind == "scene":
                    p["beats"][0]["scene"] = {}
                else:
                    p["beats"][0].pop("scene", None)
                if kind == "stage":
                    p["beats"][0]["stage"] = {}      # Pack B: every stage field has its default
                else:
                    p["beats"][0].pop("stage", None)
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
        video_render._owners["test-job"] = accounts.effective_account()
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
const { allowedRequest, VIDEO_PATH, JOB_PATH } = sandbox.module.exports;
const id = '012345abcdef', origin = 'http://localhost:9999';
const path = `/api/videos/${id}/player?aspect=16%3A9&rt=1999999999.AAAAAAAAAAAAAAAAAAAAAAAA.local.BBBBBBBBBBBBBBBBBBBBBBBB&v=1`;
assert(VIDEO_PATH.test(path));
// The account-carrying token core/design_render.sign makes since multi-account; the old two-part one is refused.
assert(!VIDEO_PATH.test(`/api/videos/${id}/player?aspect=16%3A9&rt=1999999999.AAAAAAAAAAAAAAAAAAAAAAAA&v=1`));
assert(JOB_PATH.test(`/api/designs/${id}/boards/main/render?rt=1999999999.AAAAAAAAAAAAAAAAAAAAAAAA.acct01.BBBBBBBBBBBBBBBBBBBBBBBB&v=3`));
const ok = value => allowedRequest(origin + value, origin, '', id, path, 'sport');
assert(ok(path)); assert(ok('/static/motion/engine.js')); assert(ok('/api/design-fonts/sport/test.ttf'));
assert(ok(`/api/videos/${id}/assets/${'a'.repeat(64)}.png`));
for (const bad of ['/api/settings', '/static/js/app.js', '/api/design-fonts/other/test.ttf', `/api/videos/${id}/project.json`, '/static/motion/player.html']) assert(!ok(bad), bad);
assert(!allowedRequest('https://example.com/static/motion/engine.js', origin, '', id, path, 'sport'));
'''
        subprocess.run(["node", "-e", source], cwd=ROOT, check=True, capture_output=True)
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        for protection in ("sandbox: true", "contextIsolation: true", "nodeIntegration: false", "callback(false)", "will-navigate", "will-download", "action: 'deny'", "stopped || win.isDestroyed()", "frames.length === size", "alpha ? 5 : 15", "toDataURL('image/jpeg', 0.92)"):
            self.assertIn(protection, worker)

    def test_prompt_and_skill_versions_and_lf(self):
        from core import system_prompt
        self.assertIn("To make a video, pick a look with creative_direction, then video_create with a beat sheet, video_preview, and video_render.", system_prompt.DESIGN_CANVAS_LINE)
        raw = (ROOT / "skill_templates/motion-video/SKILL.md").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b'version: "2.1.0"', raw)


def narrated(**changes):
    return {**project(beats=[
        # A title or end card speaks its own words (core/video_checks.card_narration_notes).
        {"id": "hook", "kind": "title", "text": "Clouds still float", "say": "Clouds are heavy. They still float, though, all day long."},
        {"id": "mid", "kind": "statement", "text": "No line here", "bars": 1},
        {"id": "end", "kind": "end", "text": "Look up today", "say": "Look up today."}]),
        "narration": {"voice": "af_heart", "captions": True}, **changes}


class FakeVoice:
    """Kokoro's synthesize(text, voice) -> 24 kHz PCM16: a tone a quarter second per word, so lengths are known."""
    def __init__(self, amplitude=.3):
        self.calls, self.amplitude = [], amplitude

    def __call__(self, text, voice):
        self.calls.append((text, voice))
        n = int(.25 * len(text.split()) * 24000)
        t = np.arange(n) / 24000
        return (np.sin(2 * np.pi * 220 * t) * self.amplitude * 32767).astype("<i2").tobytes()


class NarrationValidationTests(unittest.TestCase):
    def bad(self, p, path, words=""):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn(path + ":", str(caught.exception))
        self.assertIn(words, str(caught.exception))

    def test_a_line_sets_its_beat_length_and_bars_do_not(self):
        out = video_store.validate(narrated())
        self.assertEqual(out["narration"], {"voice": "af_heart", "captions": True})
        hook = out["beats"][0]
        estimate = video_store.estimate(hook["say"])
        self.assertAlmostEqual(hook["seconds"], math.ceil((video_store.LEAD + estimate + video_store.TAIL) * 30 - 1e-6) / 30)
        self.assertNotIn("seconds", out["beats"][1], "a beat without a line keeps its bars")
        p = narrated()
        p["beats"][0]["bars"] = 8
        p["beats"][0]["seconds"] = 99
        self.assertEqual(video_store.validate(p)["beats"][0]["seconds"], hook["seconds"], "bars and a written seconds are ignored")
        self.assertAlmostEqual(video_store.duration(out), hook["seconds"] + 2 + out["beats"][2]["seconds"])
        p = narrated()
        p.pop("narration")
        self.assertEqual(video_store.validate(p)["narration"], {"voice": "af_heart", "captions": True}, "a line brings the default voice")

    def test_narration_fields(self):
        for value, path in [("af_heart", "narration"), ({"voice": "Heart"}, "narration.voice"), ({"voice": "../x"}, "narration.voice"),
                            ({"voice": "af_heart", "captions": "yes"}, "narration.captions"), ({"speed": 2}, "narration.speed")]:
            self.bad(narrated(narration=value), path)
        for value, words in [("", "non-empty"), ("x" * 401, "400"), ("...", "words to speak"), (5, "text"),
                             ("word " * 30 + "and on without a single comma until it runs long", "100 characters")]:
            p = narrated()
            p["beats"][0]["say"] = value
            self.bad(p, "beats[0].say", words)

    def test_clauses_are_the_caption_parts(self):
        self.assertEqual(video_store.clauses("One. Two!  Three?"), ["One.", "Two!", "Three?"])
        long = "This sentence is long enough, with a comma in the middle of it, that it must be cut into parts so each fits on screen."
        parts = video_store.clauses(long)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(x) <= video_store.CLAUSE_LIMIT for x in parts))
        self.assertEqual(" ".join(parts), long)

    def test_spoken_is_measured_never_written(self):
        p = narrated()
        key = video_store.speech_key("af_heart", p["beats"][0]["say"])
        p["beats"][0]["spoken"] = {"key": key, "seconds": 3.0, "parts": [[.25, 1.5, "Clouds are heavy."], [1.6, 3.25, "They still float, though, all day long."]]}
        out = video_store.validate(p)
        self.assertEqual(out["beats"][0]["seconds"], math.ceil((video_store.LEAD + 3 + video_store.TAIL) * 30 - 1e-6) / 30)
        for bad in ({"key": key}, {"key": key, "seconds": -1, "parts": [[0, 1, "x"]]}, {"key": key, "seconds": 3, "parts": []},
                    {"key": key, "seconds": 3, "parts": [[2, 1, "x"]]}, {"key": key, "seconds": 3, "parts": [[0, 9, "x"]]}, "x"):
            q = copy.deepcopy(p)
            q["beats"][0]["spoken"] = bad
            self.bad(q, "beats[0].spoken")
        q = copy.deepcopy(p)
        q["narration"]["voice"] = "bm_george"
        self.assertNotIn("spoken", video_store.validate(q)["beats"][0], "another voice must be spoken again")
        q = copy.deepcopy(p)
        q["beats"][0]["say"] = "A different line."
        self.assertNotIn("spoken", video_store.validate(q)["beats"][0], "another line must be spoken again")
        q = copy.deepcopy(out)
        q["beats"][0].pop("say")
        self.assertNotIn("spoken", video_store.validate(q)["beats"][0], "a beat whose line is removed keeps its bars, not the old measurement")

    def test_the_cap_rises_for_narrated_videos_only(self):
        line = "This line is spoken by the narrator, and it runs for a while so the video gets long."
        beats = [{"id": f"b{i}", "kind": "statement", "text": "Words", "say": line} for i in range(40)]
        p = project(beats=beats)
        seconds = video_store.duration(video_store.validate(p))
        self.assertGreater(seconds, video_store.MAX_SECONDS)
        self.assertLessEqual(seconds, video_store.NARRATED_MAX_SECONDS)
        self.bad(project(beats=[{"id": f"b{i}", "kind": "title", "bars": 1} for i in range(41)]), "beats", "1 to 40")
        many = [{"id": f"b{i}", "kind": "statement", "text": "x", "say": "One two three."} for i in range(100)]
        video_store.validate(project(beats=many))
        self.bad(project(beats=many + [{"id": "extra", "kind": "end", "bars": 1}]), "beats", "1 to 100")
        too_long = [{"id": f"b{i}", "kind": "statement", "text": "x", "say": (line + " ") * 4} for i in range(60)]
        self.bad(project(beats=too_long), "beats", "480 seconds")
        self.bad(project(bpm=60, beats=[{"id": f"b{i}", "kind": "title", "bars": 1} for i in range(31)]), "beats", "120 seconds")


class NarrationTrackTests(unittest.TestCase):
    def test_lines_are_spoken_measured_cached_and_set_the_timeline(self):
        p = make(**{k: v for k, v in narrated().items() if k not in ("id", "title", "look", "beats")}, beats=narrated()["beats"])
        voice = FakeVoice()
        saved = video_narration.prepare(p["id"], voice)
        self.assertEqual(saved["version"], 2)
        self.assertEqual([c[0] for c in voice.calls], ["Clouds are heavy.", "They still float, though, all day long.", "Look up today."])
        hook = saved["beats"][0]
        speech = .25 * 3 + video_narration.SENTENCE_GAP + .25 * 7
        self.assertAlmostEqual(hook["spoken"]["seconds"], speech, places=2)
        self.assertEqual(hook["seconds"], math.ceil((video_store.LEAD + hook["spoken"]["seconds"] + video_store.TAIL) * 30 - 1e-6) / 30)
        (s1, e1, t1), (s2, e2, t2) = hook["spoken"]["parts"]
        self.assertEqual((s1, t1, t2), (video_store.LEAD, "Clouds are heavy.", "They still float, though, all day long."))
        self.assertAlmostEqual(e1 - s1, .75, places=2)
        self.assertAlmostEqual(s2 - e1, video_narration.SENTENCE_GAP, places=2)
        self.assertTrue(video_narration.clip_path(p["id"], hook["spoken"]["key"]).is_file())
        self.assertEqual(video_narration.missing(saved), [])
        again = video_narration.prepare(p["id"], voice)
        self.assertEqual((again["version"], len(voice.calls)), (2, 3), "measured lines are reused")
        saved["beats"][2]["say"] = "Look up tonight instead."
        saved = video_store.save(p["id"], saved)
        video_narration.prepare(p["id"], voice)
        self.assertEqual(voice.calls[-1][0], "Look up tonight instead.")
        self.assertEqual(len(voice.calls), 4, "only the changed line is spoken again")
        plan = video_narration.plan_text(video_store.get(p["id"]))
        self.assertIn("narrated by Kokoro voice af_heart, captions on", plan)
        self.assertIn('00:00.0-00:0', plan)
        self.assertIn('says: "Clouds are heavy. They still float, though, all day long."', plan)
        self.assertNotIn("estimated", plan)

    def test_a_pronunciation_edit_respeaks_only_the_lines_it_touches(self):
        from core import pronunciations
        old_path = pronunciations.PATH
        pronunciations.PATH = os.path.join(fixture.name, "pronunciations-narration.json")
        try:
            pronunciations.save([])
            p = make(beats=narrated()["beats"])
            voice = FakeVoice()
            first = video_narration.prepare(p["id"], voice)
            keys = {b["id"]: b["spoken"]["key"] for b in first["beats"] if "spoken" in b}
            self.assertEqual(len(voice.calls), 3)
            pronunciations.save([{"word": "Clouds", "phonemes": "kˈIɹOs"}])
            self.assertEqual(video_narration.missing(video_store.get(p["id"])), ["hook"], "only the line with the listed word is stale")
            second = video_narration.prepare(p["id"], voice)
            self.assertEqual([c[0] for c in voice.calls[3:]], ["Clouds are heavy.", "They still float, though, all day long."])
            hook, end = second["beats"][0]["spoken"]["key"], second["beats"][2]["spoken"]["key"]
            self.assertNotEqual(hook, keys["hook"])
            self.assertEqual(end, keys["end"], "a line without a listed word keeps its key and its audio")
            self.assertTrue(video_narration.clip_path(p["id"], hook).is_file())
            self.assertEqual(video_narration.missing(second), [])
            pronunciations.save([{"word": "Clouds", "phonemes": "kˈIɹOs"}, {"word": "Nguyen", "phonemes": "nwˈɛn"}])
            self.assertEqual(video_narration.missing(video_store.get(p["id"])), [], "an entry for a word no line says changes nothing")
            pronunciations.save([{"word": "clouds", "phonemes": "klˈWdz"}])
            video_narration.prepare(p["id"], voice)
            self.assertEqual(len(voice.calls), 7, "a changed sound for a listed word re-speaks its line")
            pronunciations.save([])
            self.assertEqual(video_narration.missing(video_store.get(p["id"])), ["hook"])
            self.assertEqual(video_store.speech_key("af_heart", narrated()["beats"][0]["say"]), keys["hook"])
            third = video_narration.prepare(p["id"], voice)
            self.assertEqual(len(voice.calls), 9)
            self.assertEqual(third["beats"][0]["spoken"]["key"], keys["hook"], "clearing the list returns the line to its first key")
            pronunciations.save([{"word": "float", "phonemes": "flˈOt"}, {"word": "Saint", "phonemes": "sˈAnt"}])
            self.assertTrue(pronunciations.signature("They float-ish"), "a part of a hyphenated word counts")
            self.assertTrue(pronunciations.signature("St. Louis"), "the spelled-out form Kokoro reads counts")
            self.assertEqual(pronunciations.signature("Look up today."), "")
        finally:
            pronunciations.PATH = old_path

    def test_an_edit_made_while_speaking_wins(self):
        p = make(beats=narrated()["beats"])
        def edit_midway(text, voice):
            if text == "Look up today.":
                current = video_store.get(p["id"])
                current["beats"][2]["say"] = "Changed while speaking."
                video_store.save(p["id"], current)
            return FakeVoice()(text, voice)
        saved = video_narration.prepare(p["id"], edit_midway)
        self.assertIn("spoken", saved["beats"][0])
        self.assertNotIn("spoken", saved["beats"][2], "a measurement of the old line is not stored")
        self.assertEqual(video_narration.missing(saved), ["end"])

    def test_kokoro_not_ready_says_why(self):
        p = make(beats=narrated()["beats"])
        from core import kokoro_voice
        with patch.object(kokoro_voice, "ready", return_value=(False, "Kokoro is not downloaded")):
            with self.assertRaises(video_narration.NarrationUnavailable) as caught:
                video_narration.prepare(p["id"])
        self.assertIn("Kokoro is not downloaded", str(caught.exception))
        self.assertIn("Settings > Speech", str(caught.exception))
        with patch.object(kokoro_voice, "ready", return_value=(True, None)), \
                patch.object(kokoro_voice, "voices", return_value=[{"id": "bm_george", "name": "bm_george"}]):
            with self.assertRaises(video_narration.NarrationUnavailable) as caught:
                video_narration.prepare(p["id"])
        self.assertIn("no voice af_heart", str(caught.exception))
        self.assertEqual(video_store.get(p["id"])["version"], 1, "nothing changes")

    def test_upsample_keeps_a_tone_and_doubles_the_rate(self):
        t = np.arange(2400) / 24000
        tone = (np.sin(2 * np.pi * 440 * t) * 16000).astype("<i2")
        up = video_narration._upsample(tone)
        self.assertEqual(len(up), 4800)
        ref = np.sin(2 * np.pi * 440 * np.arange(4800) / 48000) * 16000 / 32768
        self.assertLess(float(np.max(np.abs(up[200:-200] - ref[200:-200]))), .01)

    def mixed(self, volume=.7, amplitude=.3):
        p = make(beats=narrated()["beats"], music={"mood": "calm", "volume": volume})
        saved = video_narration.prepare(p["id"], FakeVoice(amplitude))
        report = {}
        return saved, video_audio.synthesize(saved, report), report

    def test_music_ducks_under_the_voice_with_headroom(self):
        saved, mix, report = self.mixed()
        self.assertEqual(mix.shape, (round(video_store.duration(saved) * 48000), 2))
        self.assertLessEqual(float(np.max(np.abs(mix))), 10 ** (-1.5 / 20) + 1e-6, "no clipping: the mix keeps -1.5 dBFS headroom")
        self.assertEqual((report["lines"], report["voice_clipped_samples"]), (2, 0))
        self.assertGreaterEqual(report["voice_over_music_db"], 15)
        voice, _ = video_narration.track(saved)
        music = video_audio._music(video_store.validate(saved))
        rate = 48000
        hook = saved["beats"][0]
        onset = int(video_store.LEAD * rate)
        self.assertLess(float(np.max(np.abs(voice[:onset - 10]))), 1e-4, "the line starts LEAD seconds into its beat")
        self.assertGreater(float(np.max(np.abs(voice[onset:onset + 2400]))), .1)
        # Music alone: between the hook line's end and the next line (the "mid" beat has no narration).
        gap_start = hook["seconds"] + .6
        gap_end = hook["seconds"] + 1.6
        speaking = (onset / rate + .5, onset / rate + 1.0)
        bed = float(np.sqrt(np.mean(music[int(gap_start * rate):int(gap_end * rate)].astype(np.float64) ** 2)))
        self.assertGreater(bed, 0)
        # Gain the mix applied to the music: under the voice it is at least 10 dB lower than between lines.
        def music_gain(a, b):
            seg = slice(int(a * rate), int(b * rate))
            residual = mix[seg].astype(np.float64) - voice[seg, None].astype(np.float64) * self.voice_gain(mix, voice, saved)
            return float(np.sqrt(np.mean(residual ** 2))) / max(1e-12, float(np.sqrt(np.mean(music[seg].astype(np.float64) ** 2))))
        under, between = music_gain(*speaking), music_gain(gap_start, gap_end)
        self.assertLess(20 * math.log10(under / between), -10)

    @staticmethod
    def voice_gain(mix, voice, saved):
        """The voice's gain in the mix, from a stretch where it speaks: least squares of mix against voice."""
        rate, a = 48000, int((video_store.LEAD + .3) * 48000)
        v, m = voice[a:a + 9600].astype(np.float64), mix[a:a + 9600, 0].astype(np.float64)
        return float(np.dot(v, m) / np.dot(v, v))

    def test_quiet_music_volume_and_clipped_voice_are_reported(self):
        _, mix, report = self.mixed(volume=0)
        self.assertIsNone(report["voice_over_music_db"])
        self.assertTrue(np.isfinite(mix).all())
        _, _, report = self.mixed(amplitude=1.2)
        self.assertGreater(report["voice_clipped_samples"], 0)
        notes = video_checks.narration_notes(narrated(), report)
        self.assertTrue(any("clipped" in n for n in notes))

    def test_a_music_only_video_is_unchanged(self):
        p = video_store.validate(project())
        self.assertTrue(np.array_equal(video_audio.synthesize(p), video_audio._music(p)))


class NarrationCheckTests(unittest.TestCase):
    def measured(self):
        p = make(beats=narrated()["beats"])
        return video_narration.prepare(p["id"], FakeVoice())

    def test_captions_match_the_script_and_every_line_is_spoken(self):
        saved = self.measured()
        self.assertEqual(video_checks.narration_notes(saved), [])
        unspoken = make(beats=narrated()["beats"])
        self.assertIn("Beat hook's line is not narrated yet; run video_narrate.", video_checks.narration_notes(unspoken))
        tampered = copy.deepcopy(saved)
        tampered["beats"][0]["spoken"]["parts"][1][2] = "Something else entirely."
        self.assertIn("Beat hook's captions do not match its script line; narrate it again.", video_checks.narration_notes(tampered))
        caption = {"beat": "hook", "kind": "text", "role": "caption", "x": 200, "y": 870, "w": 1400, "h": 120,
                   "color": "#ffffff", "bg": "#000000"}
        good = [{"time": 1, "elements": [{**caption, "text": "They still float, though, all day long."}]}]
        bad = [{"time": 1, "elements": [{**caption, "text": "Words nobody wrote."}]}]
        self.assertFalse(any("caption" in n for n in video_checks.check(saved, "16:9", good)))
        self.assertIn("A caption in beat hook is not the script's words; narrate it again.", video_checks.check(saved, "16:9", bad))
        loud = video_checks.narration_notes(saved, {"voice_clipped_samples": 0, "mix_peak_dbfs": -.2, "voice_over_music_db": 9})
        self.assertTrue(any("peaks above -1 dBFS" in n for n in loud))
        self.assertTrue(any("only 9 dB over the music" in n for n in loud))

    def test_text_cut_off_is_named(self):
        box = {"beat": "hook", "kind": "text", "role": "title", "x": 200, "y": 200, "w": 800, "h": 300, "text": "5...",
               "color": "#ffffff", "bg": "#000000", "truncated": True}
        self.assertIn("Beat hook's text is cut off with an ellipsis; shorten it.",
                      video_checks.check(video_store.validate(project()), "16:9", [{"time": 1, "elements": [box]}]))

    def test_reading_speed_uses_the_measured_length(self):
        saved = self.measured()
        self.assertFalse(any("reads faster" in n for n in video_checks.check(saved)))

    def test_a_line_on_a_title_or_end_card_is_named_unless_it_speaks_the_card(self):
        # The style pack sample captioned a scene's line ("Six months later...") on its end card (2026-11-10).
        saved = self.measured()
        self.assertEqual(video_checks.card_narration_notes(saved), [], "lines that speak their cards are by design")
        spilled = make(beats=[*narrated()["beats"][:2], {"id": "end", "kind": "end", "text": "Seasons come from a tilt",
                                                          "sub": "An original Kairos sample", "say": "Six months later, your half leans away. That is winter."}],
                       narration={"voice": "af_heart", "captions": True})
        notes = video_checks.card_narration_notes(spilled)
        self.assertTrue(len(notes) == 1 and "end card carries narration that is not its own words" in notes[0], notes)
        self.assertIn(notes[0], video_checks.check(spilled))
        for beat, ok in (({"kind": "title", "text": "Clouds weigh tons", "say": "That fluffy cloud above you weighs as much as elephants."}, True),
                         ({"kind": "end", "text": "Look up today", "say": "Next time you look up, you'll know why."}, True),
                         ({"kind": "end", "text": "Thanks", "sub": "Subscribe for more", "say": "Subscribe for more."}, True),
                         ({"kind": "title", "text": "Narrated", "say": "One short line. And a second one, after a comma."}, False)):
            self.assertEqual(video_checks.speaks_the_card(beat), ok, beat)
        # In the sampled layouts: a caption on screen while the end card shows is named, whichever beat it belongs to.
        seconds = [video_store.beat_seconds(b, 120) for b in saved["beats"]]
        on_end = sum(seconds[:2]) + .5
        caption = {"kind": "text", "role": "caption", "x": 200, "y": 870, "w": 1400, "h": 120, "color": "#ffffff", "bg": "#000000"}
        stray = [{"time": on_end, "elements": [{**caption, "beat": "hook", "text": "They still float, though, all day long."}]}]
        self.assertIn("Beat hook's caption runs onto the end card end; end the line inside its own beat.",
                      video_checks.card_narration_notes(saved, stray))
        own = [{"time": on_end, "elements": [{**caption, "beat": "end", "text": "Look up today."}]}]
        self.assertEqual(video_checks.card_narration_notes(saved, own), [])
        late = [{"time": sum(video_store.beat_seconds(b, 120) for b in spilled["beats"][:2]) + .5, "elements": [{**caption, "beat": "end", "text": "Six months later, your half leans away."}]}]
        self.assertTrue(any("caption shows on the end card" in n for n in video_checks.card_narration_notes(spilled, late)))


class NarrationToolTests(unittest.TestCase):
    def setUp(self):
        self.session = "narration-" + self._testMethodName
        self.ctx = tool_registry.ToolContext(session_id=self.session, agent_id=None, turn_taint=TurnTaint())

    def call(self, name, args):
        return run(tool_registry._REGISTRY[name].handler(args, self.ctx))

    def test_create_narrate_outline_and_edit(self):
        with patch.object(design_systems, "visible", return_value=True):
            created = self.call("video_create", {"title": "Clouds", "look": "sport", "beats": narrated()["beats"],
                                                 "narration": {"voice": "af_heart"}})
        self.assertIn("narrated by af_heart", created)
        self.assertIn("says: Clouds are heavy.", created)
        self.assertIn("length estimated until video_narrate", created)
        self.assertIn("Next: video_narrate for the shot plan", created)
        with patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(FakeVoice())})):
            plan = self.call("video_narrate", {})
        self.assertIn("Shot plan for \"Clouds\"", plan)
        self.assertIn("Every line is spoken and measured; captions match the script.", plan)
        self.assertNotIn("estimated", self.call("video_outline", {}))
        with patch.object(design_systems, "visible", return_value=True):
            edited = self.call("video_edit", {"ops": [{"op": "set", "id": "mid", "field": "say", "value": "Now this beat speaks too."},
                                                      {"op": "set", "id": "end", "field": "say", "value": ""},
                                                      {"op": "project", "field": "narration", "value": {"voice": "af_heart", "captions": False}}]})
        self.assertIn("says: Now this beat speaks too. (length estimated", edited)
        current = video_store.videos_for_chat(design_store.chat_key(self.session, None))[0]
        self.assertNotIn("say", current["beats"][2])
        self.assertFalse(current["narration"]["captions"])
        self.assertIn("Not run", self.call("video_narrate", {"video_id": "000000000000"}))

    def test_narrate_without_lines_and_long_render_wait(self):
        with patch.object(design_systems, "visible", return_value=True):
            self.call("video_create", {"title": "Plain", "look": "sport", "beats": project()["beats"]})
        self.assertIn("no beat has a say line yet", self.call("video_narrate", {}))
        short = video_store.validate(project())
        self.assertEqual(video_render.wait_seconds(short), 720)
        line = "This line is spoken by the narrator, and it runs for a while so the video gets long."
        long = video_store.validate(project(beats=[{"id": f"b{i}", "kind": "statement", "text": "x", "say": line} for i in range(60)]))
        frames = math.ceil(video_store.duration(long) * 30 - 1e-7)
        self.assertEqual(bridge.video_seconds({"frames": frames}), max(600, 60 + frames * bridge.FRAME_SECONDS))
        self.assertEqual(bridge.video_seconds({"frames": frames, "preview": True}), 600)


class EngineNarrationTests(unittest.TestCase):
    def test_layout_reads_seconds_and_captions(self):
        source = r'''
const L = await import('./static/motion/layout.js');
const assert = (await import('node:assert')).default;
const project = { bpm: 120, narration: { voice: 'af_heart', captions: true }, beats: [
  { id: 'a', kind: 'title', text: 'Hi', say: 'One. Two.', seconds: 3.2, spoken: { key: 'k', seconds: 2.5, parts: [[0.25, 1.2, 'One.'], [1.4, 2.75, 'Two.']] } },
  { id: 'e', kind: 'end', bars: 1, text: 'Bye' }] };
const p = L.normalizeProject(project);
assert.equal(p.duration, 5.2); assert.equal(p.captioned, true);
assert.equal(L.captionAt(p, 1.3).text, 'One.'); assert.equal(L.captionAt(p, 1.45).text, 'Two.');
assert.equal(L.captionAt(p, 3.1), null); assert.equal(L.captionAt(p, .1), null);
const off = L.normalizeProject({ ...project, narration: { voice: 'af_heart', captions: false } });
assert.equal(off.captioned, false); assert.equal(L.captionAt(off, 1.3), null);
for (const aspect of ['16:9', '9:16', '1:1']) {
  const safe = L.safeArea(aspect, true), band = L.captionBand(aspect);
  assert.ok(safe.y + safe.h <= band.y, aspect + ' copy stays above the caption band');
  assert.ok(band.y + band.h <= L.dimensions(aspect).height * (aspect === '9:16' ? .88 : .95), aspect + ' band inside the safe frame');
}
assert.equal(L.LIMITS.beats, 100);
'''
        subprocess.run(["node", "--input-type=module", "-e", source], cwd=ROOT, check=True, capture_output=True)

    def test_engine_burns_captions_in_and_reports_them(self):
        engine = (ROOT / "static/motion/engine.js").read_text(encoding="utf-8")
        for needle in ("drawCaption(t); return;", "drawCaption(t);\n  }", "role: 'caption'", "safeArea(aspect, project.captioned)"):
            self.assertIn(needle, engine)
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        self.assertIn("count > 14400", worker, "one worker job takes a 480-second video or chapter")
        self.assertIn("job.frames > 36000", worker, "a chaptered video runs to 20 minutes")
        self.assertEqual(video_store.NARRATED_MAX_SECONDS * 30, 14400)
        self.assertEqual(video_store.CHAPTER_MAX_SECONDS * 30, 14400)
        self.assertEqual(video_store.CHAPTERED_MAX_SECONDS * 30, 36000)


# -- Pack A: characters, sheets, scene beats, mouth timing and the sheet-match checks (Video Styles unit 3) ----------

from core import character_checks, character_sheet, character_store, style_packs, video_mouth  # noqa: E402
from routes import character_routes  # noqa: E402


def character(family="round", **changes):
    return character_store.create(character_store.starter(family, **changes))


def approved(family="round", **changes):
    meta = character(family, **changes)
    character_store.set_sheet(meta["id"], 1, b"\x89PNG fake", {"ok": True})
    return character_store.decide(meta["id"], 1, True, "alice")


def scene_project(cid, **changes):
    return project(cast=[{"character": cid, "version": 1}], beats=[
        {"id": "talk", "kind": "scene", "say": "Hello there, friend.",
         "scene": {"setting": "meadow", "cast": [{"character": cid, "speaking": True, "action": "wave"}], "props": [{"icon": "sun"}]}},
        {"id": "end", "kind": "end", "bars": 1, "text": "Bye"}], **changes)


class CharacterStoreTests(unittest.TestCase):
    def test_spec_format_is_complete_and_checked(self):
        spec = character_store.starter("square", name="Unit Square")
        for key in ("proportions", "palette", "outline", "parts", "views", "expressions", "mouths"):
            self.assertIn(key, spec)
        self.assertEqual(spec["views"], ["front", "three_quarter", "side", "back"])
        self.assertEqual(spec["expressions"], ["neutral", "happy", "surprised", "worried", "thinking"])
        self.assertEqual(spec["mouths"], ["rest", "A", "E", "O", "MBP", "FV"])
        for bad, path in [({"palette": {"body": "orange"}}, "palette.body"), ({"family": "hexagon"}, "family"),
                          ({"outline": 30}, "outline"), ({"proportions": {"head": .9}}, "proportions.head"),
                          ({"accessory": "crown"}, "accessory"), ({"views": ["front"]}, "views"), ({"name": "!"}, "name"),
                          ({"cape": True}, "cape")]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "^" + re.escape(path)):
                character_store.merged(spec, bad)
        flat = dict(spec["palette"], **{k: "#111111" for k in ("body", "body_shade", "head", "limb", "eye")})
        with self.assertRaisesRegex(ValueError, "at least 6 different colours"):
            character_store.merged(spec, {"palette": flat})

    def test_every_change_is_a_new_version_and_approval_is_one_way(self):
        meta = character("triangle", name="Version Tri")
        cid = meta["id"]
        with self.assertRaisesRegex(ValueError, "already has a character named"):
            character("round", name="version tri")
        with self.assertRaisesRegex(ValueError, "nothing changed"):
            character_store.new_version(cid, {"name": "Version Tri"})
        with self.assertRaises(character_store.ApprovalError):
            character_store.decide(cid, 1, True, "alice")            # a draft has no sheet to approve
        character_store.set_sheet(cid, 1, b"\x89PNG one", {"ok": True})
        self.assertEqual([p["id"] for p in character_store.pending()].count(cid), 1)
        character_store.decide(cid, 1, True, "alice")
        with self.assertRaises(character_store.ApprovalError):
            character_store.set_sheet(cid, 1, b"\x89PNG two", {"ok": True})
        meta = character_store.new_version(cid, {"palette": {"accent": "#123456"}}, note="New accent")
        self.assertEqual([(v["version"], v["status"]) for v in meta["versions"]], [(1, "approved"), (2, "draft")])
        self.assertEqual(character_store.spec(cid, 1)["palette"]["accent"], character_store.STARTERS["triangle"]["palette"]["accent"])
        self.assertEqual(character_store.spec(cid, 2)["palette"]["accent"], "#123456")
        self.assertEqual(character_store.approved_version(meta), 1)
        character_store.set_sheet(cid, 2, b"\x89PNG three", {"ok": True})
        meta = character_store.decide(cid, 2, False, "alice", "Too dark")
        self.assertEqual((meta["versions"][1]["status"], meta["versions"][1]["reason"]), ("rejected", "Too dark"))
        self.assertTrue(character_store.is_approved(cid, 1))
        self.assertFalse(character_store.is_approved(cid, 2))
        with self.assertRaises(LookupError):
            character_store.get("../../etc")


class SceneValidationTests(unittest.TestCase):
    def test_scene_beats_cast_and_palette(self):
        cid = character(name="Scene Pip")["id"]
        p = video_store.validate(scene_project(cid))
        self.assertEqual(p["palette"], "dawn")
        member = p["beats"][0]["scene"]["cast"][0]
        self.assertEqual((member["view"], member["expression"], member["facing"], member["x"]), ("front", "neutral", "right", .5))
        bad = [(lambda q: q.pop("cast"), "beats[0].scene.cast[0].character"),
               (lambda q: q.update(cast=[{"character": "0" * 12, "version": 1}]), "cast[0]"),
               (lambda q: q.update(cast=[{"character": cid, "version": 9}]), "cast[0]"),
               (lambda q: q.update(palette="neon"), "palette"),
               (lambda q: q["beats"][0]["scene"].update(setting="volcano"), "beats[0].scene.setting"),
               (lambda q: q["beats"][0]["scene"].update(shot="extreme"), "beats[0].scene.shot"),
               (lambda q: q["beats"][0]["scene"]["props"].append({"icon": "logo"}), "beats[0].scene.props[1].icon"),
               (lambda q: q["beats"][0]["scene"]["cast"][0].update(action="dance"), "beats[0].scene.cast[0].action"),
               (lambda q: q["beats"][0]["scene"]["cast"][0].update(turn="up"), "beats[0].scene.cast[0].turn"),
               (lambda q: q["beats"][1].update(scene={}), "beats[1].scene")]
        for change, path in bad:
            with self.subTest(path=path):
                q = scene_project(cid)
                change(q)
                with self.assertRaisesRegex(ValueError, "^" + re.escape(path)):
                    video_store.validate(q)
        two = character("square", name="Scene Bo")["id"]
        q = scene_project(cid)
        q["cast"].append({"character": two, "version": 1})
        q["beats"][0]["scene"]["cast"].append({"character": two, "speaking": True})
        with self.assertRaisesRegex(ValueError, "one narrator voice"):
            video_store.validate(q)

    def test_spoken_mouth_is_measured_not_written(self):
        cid = character(name="Mouth Pip")["id"]
        q = scene_project(cid)
        key = video_store.speech_key("af_heart", q["beats"][0]["say"])
        q["narration"] = {"voice": "af_heart", "captions": True}
        q["beats"][0]["spoken"] = {"key": key, "seconds": 1.0, "parts": [[.25, 1.25, "Hello there, friend."]], "mouth": "X" * 8 + "AEOM" * 7}
        self.assertEqual(video_store.validate(q)["beats"][0]["spoken"]["mouth"][:9], "XXXXXXXXA")
        for mouth in ("XYZ", "A" * 80, 7):
            q["beats"][0]["spoken"]["mouth"] = mouth
            with self.subTest(mouth=mouth), self.assertRaisesRegex(ValueError, r"beats\[0\]\.spoken"):
                video_store.validate(q)


class MouthTests(unittest.TestCase):
    def test_shapes_follow_the_envelope(self):
        rate, t = 24000, np.arange(24000) / 24000
        line = np.concatenate([np.zeros(4800), np.sin(2 * np.pi * 180 * t[:7200]) * .5, np.zeros(1600),
                               np.random.RandomState(3).randn(4800) * .08, np.sin(2 * np.pi * 2600 * t[:7200]) * .3])
        codes = video_mouth.shapes((line * 32767).astype("<i2"), rate)
        self.assertEqual(len(codes), math.ceil(len(line) / 800))
        self.assertTrue(codes.startswith("XXXXX"), codes)
        self.assertIn("M", codes, "a short silence inside speech closes the lips")
        self.assertIn("F", codes, "quiet noise shows the teeth")
        self.assertTrue({"O", "A"} & set(codes[6:14]) and {"E", "A"} & set(codes[-8:]), codes)
        self.assertEqual(codes, video_mouth.shapes((line * 32767).astype("<i2"), rate), "deterministic")
        self.assertEqual(video_mouth.shapes(np.zeros(2400, dtype="<i2")), "XXX")
        beat = video_mouth.for_beat((line * 32767).astype("<i2"), video_store.LEAD, rate)
        self.assertEqual(beat, "X" * 8 + codes + "X")

    def test_narration_times_the_mouth_of_scene_beats_only(self):
        cid = character(name="Narrated Pip")["id"]
        q = scene_project(cid)
        q.pop("id")
        q["beats"].insert(0, {"id": "intro", "kind": "title", "text": "Hi", "say": "A title line."})
        made = video_store.create(**q, owner="alice")
        voice = FakeVoice()
        prepared = video_narration.prepare(made["id"], voice)
        intro, talk = prepared["beats"][0], prepared["beats"][1]
        self.assertNotIn("mouth", intro["spoken"])
        self.assertRegex(talk["spoken"]["mouth"], r"^X{8}[AEOMF]+X$")
        # A beat measured before it became a scene gets its mouth from the line already spoken, without speaking again.
        current = video_store.get(made["id"])
        current["beats"][0].update(kind="scene", scene={"cast": [{"character": cid}]})
        video_store.save(made["id"], current)
        calls = len(voice.calls)
        again = video_narration.prepare(made["id"], voice)
        self.assertEqual(len(voice.calls), calls)
        self.assertIn("mouth", again["beats"][0]["spoken"])


class SheetMatchTests(unittest.TestCase):
    """The sheet-match measurement on a synthetic figure drawn like the rig draws it."""
    def figure(self, spec, height=500, size=(1200, 800), feet=(600, 760), outline_px=None):
        im = Image.new("RGB", size, "#fff1df")
        d = ImageDraw.Draw(im)
        pal, o = spec["palette"], outline_px or round(spec["outline"] / 1000 * height)
        centre, body_h = character_checks.body_centre(spec, height)
        cx, cy = feet[0], feet[1] + centre
        bw = spec["proportions"]["body_width"] * height
        d.rectangle((cx - bw / 2 - 40, cy - 60, cx - bw / 2 + 10, feet[1]), fill=pal["limb"], outline=pal["outline"], width=o)
        d.ellipse((cx - bw / 2, cy - body_h / 2, cx + bw / 2, cy + body_h / 2), fill=pal["body"], outline=pal["outline"], width=o)
        head = spec["proportions"]["head"] * height
        d.ellipse((cx - head / 2, feet[1] - height, cx + head / 2, feet[1] - height + head), fill=pal["head"], outline=pal["outline"], width=o)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=92)
        box = {"kind": "character", "beat": "talk", "character": "c1", "shot": "medium", "view": "front", "x": cx - bw, "y": feet[1] - height * 1.1,
               "w": bw * 2, "h": height * 1.15, "height": height, "body": {"cx": cx, "cy": cy, "w": bw, "h": body_h}, "short": size[1] * 1.35}
        return out.getvalue(), box

    def test_a_matching_figure_passes_and_drift_is_named(self):
        spec = character_store.starter("round")
        frame, box = self.figure(spec)
        cast = {"c1": {"spec": spec, "name": "Pip", "metrics": {"body_ratio": round(character_checks.body_centre(spec, 1)[1] / 2, 3)}}}
        self.assertEqual(character_checks.frame_notes(frame, [box], cast), [])
        wrong = {"c1": {**cast["c1"], "spec": {**spec, "palette": {**spec["palette"], "body": "#00ff00", "body_shade": "#00dd00"}}}}
        self.assertTrue(any("body colour is off the approved sheet" in n for n in character_checks.frame_notes(frame, [box], wrong)))
        thick, box2 = self.figure(spec, outline_px=12)
        self.assertTrue(any("outline measures" in n for n in character_checks.frame_notes(thick, [box2], cast)))
        self.assertTrue(any("outside the wide shot" in n for n in character_checks.frame_notes(frame, [{**box, "shot": "wide", "short": 900}], cast)))
        # A caption over the body's lower edge: nothing to measure there, so no false alarm.
        caption = {"kind": "text", "x": 0, "y": box["body"]["cy"] + 40, "w": 1200, "h": 60}
        self.assertEqual(character_checks.frame_notes(thick, [box2, caption], cast), [])


class SheetRenderTests(unittest.TestCase):
    def test_layout_page_and_submit(self):
        meta = character(name="Sheet Pip")
        page = character_sheet.page(meta["id"], 1)
        self.assertIn('id="kd-sheet-data"', page)
        self.assertIn('/static/motion/sheet.js', page)
        self.assertNotIn("<!--KD-SHEET-->", page)
        cells = character_sheet.LAYOUT
        self.assertEqual([c["view"] for c in cells["views"]], list(character_store.VIEWS))
        self.assertEqual([c["mouth"] for c in cells["mouths"]], list(character_store.MOUTHS))
        for cell in cells["views"] + cells["expressions"] + cells["mouths"]:
            self.assertLessEqual(cell["x"] + cell["w"], cells["w"])
            self.assertLessEqual(cell["y"] + cell["h"], cells["h"])
        path = character_sheet.path_for(meta["id"], 1)
        self.assertRegex(path, r"^/api/characters/[a-f0-9]{12}/sheet\?v=1&rt=")
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        self.assertIn("SHEET_PATH", worker)
        with patch.object(character_checks, "sheet_metrics", return_value={"ok": False, "problems": ["The sheet's front view is empty."]}):
            with self.assertRaisesRegex(ValueError, "front view is empty"):
                run(character_sheet.submit(meta["id"], 1, png=b"\x89PNG x"))
        with patch.object(character_checks, "sheet_metrics", return_value={"ok": True, "problems": []}):
            done = run(character_sheet.submit(meta["id"], 1, png=b"\x89PNG x"))
        self.assertEqual(done["versions"][0]["status"], "awaiting_approval")
        self.assertFalse(done["notified"], "no Content Studio Producer in this account")


class CharacterRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(character_routes.router)
        self.app.include_router(video_routes.router)
        self.app.dependency_overrides[require_user] = lambda: "alice"
        self.client = TestClient(self.app)

    def test_make_version_sheet_and_approve(self):
        made = self.client.post("/api/characters", json={"family": "square", "name": "Route Bo"})
        self.assertEqual(made.status_code, 200, made.text)
        cid = made.json()["id"]
        self.assertEqual(self.client.post("/api/characters", json={"family": "blob"}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/characters/{cid}/versions/1/approve").status_code, 409, "a draft cannot be approved")
        with patch.object(character_sheet, "render", AsyncMock(return_value=b"\x89PNG x")), \
                patch.object(character_checks, "sheet_metrics", return_value={"ok": True, "problems": []}):
            sent = self.client.post(f"/api/characters/{cid}/versions/1/sheet")
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(sent.json()["versions"][0]["sheet_url"], f"/api/characters/{cid}/versions/1/sheet.png")
        self.assertEqual(self.client.get(f"/api/characters/{cid}/versions/1/sheet.png").content, b"\x89PNG x")
        self.assertIn(cid, [p["id"] for p in self.client.get("/api/characters").json()["pending"]])
        approved_ = self.client.post(f"/api/characters/{cid}/versions/1/approve").json()
        self.assertEqual(approved_["approved_version"], 1)
        version = self.client.post(f"/api/characters/{cid}/versions", json={"changes": {"accessory": "cap"}, "note": "A cap"}).json()
        self.assertEqual([v["status"] for v in version["versions"]], ["approved", "draft"])
        # The sheet page: a signed-in person, or the worker's signed token; never anyone else.
        self.assertEqual(self.client.get(f"/api/characters/{cid}/sheet?v=1&rt=bad").status_code, 404)
        signed = self.client.get(character_sheet.path_for(cid, 1))
        self.assertEqual(signed.status_code, 200)
        self.assertIn("script-src", signed.headers["content-security-policy"])
        # The worker's token is made for one version: it does not open another.
        self.assertEqual(self.client.get(character_sheet.path_for(cid, 1).replace("v=1", "v=2")).status_code, 404)

    def test_render_needs_approved_cast_and_the_player_gets_the_specs(self):
        draft = character(name="Player Pip")["id"]
        p = scene_project(draft)
        p.pop("id")
        made = self.client.post("/api/videos", json=p)
        self.assertEqual(made.status_code, 200, made.text)
        vid = made.json()["id"]
        self.assertIn("is draft; a video may only use an approved version", " ".join(video_render.cast_problems(made.json())))
        with self.assertRaisesRegex(ValueError, "^cast: Player Pip version 1 is draft"):
            video_render.start(vid, "16:9")
        page = video_routes.player_page(video_store.get(vid))
        data = json.loads(page.split('id="kd-project">')[1].split("</script>")[0])
        self.assertEqual(data["characters"][draft]["spec"]["name"], "Player Pip")
        self.assertEqual(data["palette"], "dawn")
        self.assertIn("is not approved yet", " ".join(video_render.character_notes(video_store.get(vid), [], [b"x"], [0.])))
        character_store.set_sheet(draft, 1, b"\x89PNG", {"ok": True})
        character_store.decide(draft, 1, True, "alice")
        self.assertEqual(video_render.cast_problems(video_store.get(vid)), [])


class PackRegistryTests(unittest.TestCase):
    def test_pack_a_is_available_and_users_have_a_seam(self):
        self.assertTrue(style_packs.available("flat-2d"))
        self.assertTrue(style_packs.available("motion-type"))
        self.assertTrue(style_packs.available("glossy-3d"))      # Pack B since unit 5
        self.assertFalse(style_packs.available("voxel-3d"))
        self.assertEqual(style_packs.user_packs(), [])
        from services.content_studio import formats
        cost = formats.cost("flat-2d", 120)
        self.assertEqual((cost["available"], cost["units"], cost["cheapest_units"], cost["ratio"]), (True, 2.0, 2.0, 1.0))   # measured: the same 2D engine
        engine = (ROOT / "static/motion/scene.js").read_text(encoding="utf-8")
        for name, palette in style_packs.PALETTES.items():
            self.assertIn(f"{name}: {{ sky: ['{palette['sky'][0]}', '{palette['sky'][1]}']", engine, "scene.js palettes match the registry")

    def test_layout_samples_stay_under_the_worker_limit(self):
        line = "A short spoken line."
        long = video_store.validate(project(beats=[{"id": f"b{i}", "kind": "statement", "text": "x", "say": line} for i in range(100)]))
        long["version"] = 1
        job = video_render._job(long, "16:9", "j1", frame_times=[0, 1, 2])
        self.assertLessEqual(len(job["layoutTimes"]), video_render.LAYOUT_SAMPLES)
        self.assertTrue({0, 1, 2} <= set(job["layoutTimes"]), "frames kept for the checks always get their layout")


class CharacterToolTests(unittest.TestCase):
    def setUp(self):
        self.ctx = tool_registry.ToolContext(session_id="characters-" + self._testMethodName, agent_id=None, turn_taint=TurnTaint())

    def call(self, name, args):
        return run(tool_registry._REGISTRY[name].handler(args, self.ctx))

    def test_design_list_and_scene_docs(self):
        made = self.call("character_make", {"family": "round", "name": "Tool Pip", "changes": {"accessory": "scarf"}})
        self.assertIn("Version 1 is a draft. Run character_sheet", made)
        cid = re.search(r"id ([a-f0-9]{12})", made).group(1)
        self.assertIn("v2 draft", self.call("character_make", {"character_id": cid, "changes": {"palette": {"accent": "#abcdef"}}}))
        self.assertIn("Not run", self.call("character_make", {"name": "No Family"}))
        listing = self.call("character_list", {})
        self.assertIn("Tool Pip (round, 2D", listing)
        self.assertIn("Settings: meadow", listing)
        self.assertIn("scene={setting", tool_registry._REGISTRY["video_create"].description)
        with patch.object(character_sheet, "render", AsyncMock(side_effect=character_sheet.Unavailable("Needs the desktop app."))):
            self.assertIn("Not run: Needs the desktop app.", self.call("character_sheet", {"character_id": cid, "version": 2}))


# -- Long-form: chapters, resumable renders, the plan gate, YouTube chapters (Video Styles unit 4) -------------------

def chaptered(lines=9, per=3, **changes):
    """A narrated video in chapters: `lines` statement beats, a new chapter every `per` beats."""
    beats = [{"id": f"b{i}", "kind": "statement", "text": f"Point {i}", "say": f"This is line number {i} of the long video."}
             for i in range(lines)]
    chapters = [{"id": f"c{n}", "title": f"Part {n + 1}", "start": f"b{i}"} for n, i in enumerate(range(0, lines, per))]
    return {**project(beats=beats), "narration": {"voice": "af_heart", "captions": True}, "chapters": chapters, **changes}


def make_long(**changes):
    p = chaptered(**changes)
    return video_store.create(**{k: v for k, v in p.items() if k != "id"}, owner="alice", chat_key_="chat-alice")


class ChapterValidationTests(unittest.TestCase):
    def bad(self, p, path, words=""):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn(path + ":", str(caught.exception))
        self.assertIn(words, str(caught.exception))

    def test_chapters_partition_the_frames_in_beat_order(self):
        p = chaptered()
        p["chapters"].reverse()
        out = video_store.validate(p)
        self.assertEqual([c["start"] for c in out["chapters"]], ["b0", "b3", "b6"], "kept in beat order")
        spans = video_store.chapter_spans(out)
        total = math.ceil(video_store.duration(out) * 30 - 1e-7)
        self.assertEqual(sum(s["frames"] for s in spans), total)
        self.assertEqual(spans[0]["first_frame"], 0)
        for a, b in zip(spans, spans[1:]):
            self.assertEqual(a["first_frame"] + a["frames"], b["first_frame"])
            self.assertEqual(a["last"], b["first"])
        self.assertTrue(video_store.chaptered(out))
        self.assertFalse(video_store.chaptered(video_store.validate(chaptered(chapters=[]))), "no chapters is a normal video")

    def test_chapter_rules(self):
        self.bad(chaptered(chapters=[{"title": "Only", "start": "b0"}]), "chapters", "2 to")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b1"}, {"title": "B", "start": "b4"}]), "chapters", "first beat")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b0"}, {"title": "B", "start": "nope"}]), "chapters[1].start")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b0"}, {"title": "B", "start": "b0"}]), "chapters[1].start", "same beat")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b0"}, {"title": "", "start": "b3"}]), "chapters[1].title")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b0"}, {"title": "B<i>", "start": "b3"}]), "chapters[1].title", "one line")
        self.bad(chaptered(chapters=[{"title": "A", "start": "b0"}, {"title": "B", "start": "b3", "at": 1}]), "chapters[1].at")
        music_only = project(chapters=[{"title": "A", "start": "hook"}, {"title": "B", "start": "end"}])
        self.bad(music_only, "chapters", "narrated")

    def test_the_cap_rises_to_twenty_minutes_in_chapters_only(self):
        long_line = "This sentence has ten short words in it right here. " * 6
        beats = [{"id": f"b{i}", "kind": "statement", "text": "Long", "say": long_line.strip()} for i in range(30)]
        flat = {**project(beats=beats), "narration": {"voice": "af_heart", "captions": True}}
        self.bad(flat, "beats", "chapters (up to 20 minutes)")
        out = video_store.validate({**flat, "chapters": [{"title": f"P{n}", "start": f"b{n * 10}"} for n in range(3)]})
        self.assertGreater(video_store.duration(out), video_store.NARRATED_MAX_SECONDS)
        self.bad({**flat, "chapters": [{"title": "A", "start": "b0"}, {"title": "B", "start": "b29"}]}, "chapters", "split it")

    def test_youtube_chapter_list(self):
        from core import video_longform
        out = video_store.validate(chaptered())
        text, problems = video_longform.youtube_chapters(out)
        lines = text.split("\n")
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].startswith("00:00 Part 1"))
        self.assertTrue(all(re.fullmatch(r"\d\d:\d\d Part \d", line) for line in lines), lines)
        self.assertEqual(problems, [])
        two = video_store.validate(chaptered(lines=4, per=2))
        self.assertIn("at least 3", video_longform.youtube_chapters(two)[1][0])
        short = chaptered(lines=4, per=1)
        for b in short["beats"]:
            b["say"] = "Hi."
        self.assertIn("at least 10 seconds", " ".join(video_longform.youtube_chapters(video_store.validate(short))[1]))


class ChapterKeyTests(unittest.TestCase):
    def test_an_edit_to_one_chapter_changes_only_its_part(self):
        from core import video_longform
        out = video_store.validate(chaptered())
        keys = video_longform.chapter_keys(out, "16:9")
        self.assertEqual(len(set(keys)), 3)
        edited = copy.deepcopy(out)
        edited["beats"][4]["text"] = "Changed in the middle of chapter two"
        after = video_longform.chapter_keys(video_store.validate(edited), "16:9")
        self.assertEqual([a == b for a, b in zip(keys, after)], [True, False, True])
        self.assertNotEqual(keys, video_longform.chapter_keys(out, "9:16"), "another aspect draws other frames")
        looked = video_longform.chapter_keys(video_store.validate({**out, "look": "nordic"}), "16:9")
        self.assertTrue(all(a != b for a, b in zip(keys, looked)))


class PlanGateTests(unittest.TestCase):
    def test_a_long_video_renders_only_after_the_person_approves_its_plan(self):
        from core import video_plan
        p = make_long()
        self.assertEqual(video_plan.state(p)["status"], "none")
        with patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(bridge, "available", return_value=True):
            with self.assertRaises(ValueError) as caught:
                video_render.start(p["id"], "16:9")
        self.assertIn("plan:", str(caught.exception))
        sent = video_plan.submit(p["id"], by="model")
        self.assertEqual(sent["status"], "awaiting_approval")
        self.assertIn("Chapter 2 at", sent["text"])
        self.assertIn(p["id"], [w["video_id"] for w in video_plan.waiting()])
        self.assertEqual(video_plan.decide(p["id"], True, "alice")["status"], "approved")
        self.assertEqual(video_plan.problems(video_store.get(p["id"])), [])
        # A measurement does not undo it; a changed line does.
        measured = video_store.get(p["id"])
        self.assertEqual(video_plan.plan_hash(measured), video_plan.plan_hash({**measured, "beats": [
            {**b, "seconds": 1.0} for b in measured["beats"]]}))
        measured["beats"][0]["say"] = "A different first line."
        changed = video_store.save(p["id"], measured)
        self.assertEqual(video_plan.state(changed)["status"], "changed")
        self.assertIn("changed after it was approved", video_plan.problems(changed)[0])
        self.assertEqual(video_plan.problems(video_store.get(make()["id"])), [], "a Short needs no plan approval")
        with self.assertRaises(ValueError):
            video_plan.submit(make()["id"], by="model")

    def test_plan_routes_are_the_persons(self):
        app = FastAPI()
        app.include_router(video_routes.router)
        app.dependency_overrides[require_user] = lambda: "alice"
        client = TestClient(app)
        p = make_long()
        self.assertEqual(client.get(f"/api/videos/{p['id']}/plan").json()["status"], "none")
        self.assertEqual(client.post(f"/api/videos/{p['id']}/plan/reject", json={"reason": "Shorter, please"}).json()["status"], "rejected")
        self.assertEqual(client.post(f"/api/videos/{p['id']}/plan/approve").json()["status"], "approved")
        renders = client.get(f"/api/videos/{p['id']}/long-renders").json()
        self.assertEqual(renders["renders"], [])
        self.assertIn("parts", renders["disk"])
        self.assertEqual(client.post(f"/api/videos/{p['id']}/parts/clean").json()["freed"], 0)
        self.assertEqual(client.get(f"/api/videos/{p['id']}/renders/16-9-v1.chapters.txt").status_code, 404, "allowed name, no file yet")
        self.assertEqual(client.get(f"/api/videos/{p['id']}/renders/..%2Fplan.json").status_code, 404)


class LongRenderTests(unittest.IsolatedAsyncioTestCase):
    """The chapter loop with a stand-in worker and encoder: parts, a stop, a resume that reuses them, the join."""
    async def asyncSetUp(self):
        bridge._queue = None
        bridge._pending.clear()
        bridge._video_parts.clear()
        self.jobs = []

    def fakes(self, stop_after=None):
        test = self

        class Encoder:
            def __init__(self, path, wav):
                self.path, self.count = Path(path), 0
                self.path.write_bytes(b"")
                test.assertIsNone(wav, "a chapter part is picture only")

            def write(self, raw):
                self.count += 1

            def finish(self):
                self.path.write_text(str(self.count))

            def abort(self):
                self.path.unlink(missing_ok=True)

        async def capture(job, consumer):
            test.jobs.append(job)
            test.assertLessEqual(job["first"] + job["count"], job["frames"])
            test.assertTrue(all(job["first"] / 30 <= t < (job["first"] + job["count"]) / 30 + 1e-9 for t in job["layoutTimes"]))
            for offset in range(0, job["count"], 15):
                if stop_after is not None and len(test.jobs) > stop_after and offset >= 15:
                    await asyncio.Future()       # stuck in this chapter until cancelled
                await consumer([image()] * min(15, job["count"] - offset), [{"time": t, "elements": []} for t in job["layoutTimes"]] if offset == 0 else [])
            return {"frames": job["count"]}

        def join(parts, wav, out):
            Path(out).write_text(str(sum(int(Path(p).read_text()) for p in parts)))
            return out

        return [patch.object(ffmpeg_tools, "find", return_value="ffmpeg"), patch.object(ffmpeg_tools, "Encoder", Encoder),
                patch.object(bridge, "available", return_value=True), patch.object(bridge, "video", side_effect=capture),
                patch.object(ffmpeg_tools, "count_frames", side_effect=lambda path, *a: int(Path(path).read_text())),
                patch.object(ffmpeg_tools, "join", side_effect=join),
                patch.object(ffmpeg_tools, "loudness", return_value={"input_i": -16, "input_tp": -1.5}),
                patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(FakeVoice())}))]

    async def test_stop_resume_reuse_and_join(self):
        from core import video_longform, video_plan
        p = make_long()
        video_plan.decide(p["id"], True, "alice")
        patches = self.fakes(stop_after=1)
        for item in patches:
            item.start()
        try:
            job = video_render.start(p["id"], "16:9")
            self.assertEqual(job["kind"], "long")
            for _ in range(400):
                await asyncio.sleep(.01)
                state = video_render.status(job["id"])
                if state["chapters"] and state["chapters"][1]["state"] == "rendering" and state["chapters"][1]["done"] >= 15:
                    break
            self.assertEqual(video_render.status(job["id"])["chapters"][0]["state"], "done")
            self.assertIsNotNone(video_render.status(job["id"])["eta_seconds"])
            video_render.cancel(job["id"])
            await asyncio.gather(video_render._tasks[job["id"]], return_exceptions=True)
            stopped = video_render.status(job["id"])
            self.assertEqual(stopped["status"], "paused")
            self.assertEqual([c["state"] for c in stopped["chapters"]], ["done", "waiting", "waiting"])
            stored = video_longform.describe(p["id"])
            self.assertEqual(stored[0]["status"], "paused")
            self.assertTrue(stored[0]["resumable"])
            # An app restart: the live job is gone and the record says running; Studio shows it interrupted.
            record = video_longform.record(p["id"], "16:9")
            video_longform._save_record(p["id"], "16:9", {**record, "status": "running"})
            video_render._jobs.pop(job["id"])
            self.assertEqual(video_longform.describe(p["id"])[0]["status"], "interrupted")
            patches[3].stop()
            patches[3] = patch.object(bridge, "video", side_effect=self.fakes()[3].kwargs["side_effect"])
            patches[3].start()
            before = len(self.jobs)
            again = video_render.start(p["id"], "16:9")
            await video_render._tasks[again["id"]]
            done = video_render.status(again["id"])
            self.assertEqual(done["status"], "ready", done["status"])
            self.assertEqual(done["reused"], 1)
            self.assertTrue(done["resumed"])
            self.assertEqual(len(self.jobs) - before, 2, "only the two unfinished chapters render again")
            total = math.ceil(video_store.duration(video_store.get(p["id"])) * 30 - 1e-7)
            self.assertEqual(done["frames_total"], total)
            renders = video_store._folder(p["id"]) / "renders"
            self.assertEqual(int((renders / done["file"]).read_text()), total)
            self.assertTrue(done["chapters_text"].startswith("00:00 Part 1"))
            self.assertEqual(video_longform.chapters_for_render(done["url"]), done["chapters_text"])
            for name in ("sheet-16-9.png", "thumb-16-9.png", "soundtrack.wav", done["chapters_file"]):
                self.assertTrue((renders / name).is_file(), name)
            self.assertGreater(done["disk"]["parts"], 0)
            # An edit to one chapter renders only that chapter; the old part is removed when the render finishes.
            edited = video_store.get(p["id"])
            edited["beats"][4]["text"] = "Only chapter two changes"
            video_store.save(p["id"], edited)
            video_plan.decide(p["id"], True, "alice")
            before = len(self.jobs)
            third = video_render.start(p["id"], "16:9")
            await video_render._tasks[third["id"]]
            self.assertEqual(video_render.status(third["id"])["status"], "ready")
            self.assertEqual(len(self.jobs) - before, 1)
            parts = video_longform._parts(p["id"], "16:9")
            self.assertEqual(len(list(parts.glob("*.mp4"))), 3, "the replaced part is cleaned up")
            self.assertGreater(video_longform.clean(p["id"]), 0)
            self.assertFalse(parts.exists())
        finally:
            for item in patches:
                item.stop()


class RealJoinTests(unittest.TestCase):
    @unittest.skipUnless(ffmpeg_tools.find(), "FFmpeg is not on this machine")
    def test_parts_join_without_reencoding_and_keep_every_frame(self):
        import tempfile
        folder = Path(tempfile.mkdtemp(dir=fixture.name))
        parts = []
        for k, n in enumerate((37, 41, 22)):
            encoder = ffmpeg_tools.Encoder(folder / f"p{k}.mp4", None)
            for i in range(n):
                encoder.write(image(size=(320, 180)))
            encoder.finish()
            self.assertEqual(ffmpeg_tools.count_frames(folder / f"p{k}.mp4"), n)
            parts.append(folder / f"p{k}.mp4")
        wav = folder / "s.wav"
        with wave.open(str(wav), "wb") as out:
            out.setnchannels(2)
            out.setsampwidth(2)
            out.setframerate(48000)
            t = np.arange(int(100 / 30 * 48000)) / 48000
            out.writeframes(np.repeat((np.sin(2 * np.pi * 440 * t) * 8000).astype("<i2"), 2).tobytes())
        joined = ffmpeg_tools.join(parts, wav, folder / "out.mp4")
        self.assertEqual(ffmpeg_tools.count_frames(joined), 100)
        check = subprocess.run([ffmpeg_tools.find(), "-v", "error", "-i", str(joined), "-f", "null", "-"], capture_output=True, text=True)
        self.assertEqual(check.stderr.strip(), "", "the joined file decodes without errors")
        self.assertLess(abs(ffmpeg_tools.loudness(joined)["input_i"] + 16), 1.5)
        picture_only = ffmpeg_tools.Encoder(folder / "x.mp4", None)
        picture_only.abort()
        self.assertIn("-an", picture_only.argv)
        self.assertNotIn("-shortest", picture_only.argv)


class LongToolTests(unittest.TestCase):
    def setUp(self):
        session = session_manager.create_session(owner_user="alice")
        self.ctx = tool_registry.ToolContext(session_id=session["id"], surface=tool_registry.CODEX, turn_taint=TurnTaint())

    def call(self, name, args):
        return run(tool_registry._REGISTRY[name].handler(args, self.ctx))

    def test_create_in_chapters_outline_submit_and_render_refusal(self):
        reply = self.call("video_create", {"title": "Long", "look": "sport", "beats": [], "chapters": [
            {"title": "Start", "beats": [{"kind": "title", "text": "Long", "say": "Long."}, {"kind": "statement", "text": "One", "say": "One idea."}]},
            {"title": "Middle", "beats": [{"kind": "statement", "text": "Two", "say": "Two ideas."}]},
            {"title": "End", "beats": [{"kind": "statement", "text": "Three", "say": "Three ideas here."}]}]})
        self.assertIn("Chapter c1: Start", reply)
        p = video_store.videos_for_chat(self.ctx.session_id)[0]
        self.assertEqual([c["start"] for c in p["chapters"]], ["c1b1", "c2b1", "c3b1"])
        self.assertIn("Not run", self.call("video_render", {"video_id": p["id"]}))
        with patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(FakeVoice())})):
            sent = self.call("video_submit_plan", {"video_id": p["id"]})
        self.assertIn("waits for the person's approval", sent)
        self.assertIn("Chapter 3 at", sent)
        self.assertIn("No render of this video yet", self.call("video_render_status", {"video_id": p["id"]}))
        self.assertIn("approves its shot plan", tool_registry._REGISTRY["video_create"].description)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        fixture.cleanup()
