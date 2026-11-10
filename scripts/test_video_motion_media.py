"""Content Studio editor steps 5 to 7 on the server: keyframes in the clip schema and the video_edit operations (Ask
Kairos sets them too), 60 frames a second through the render path's maths, the export formats made by FFmpeg from an
MP4 (WebM VP9/Opus, MOV H.264 copy, GIF under its cap), video clips from the person's own file (decoded frames, its
sound, limits, determinism) and word caption fields. Real FFmpeg; no network, no real model."""
import asyncio
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="video-motion-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import ffmpeg_tools, video_agent, video_export, video_longform, video_media, video_render, video_store, video_tools, video_tracks
from core.middleware import require_user
from routes import video_routes

FFMPEG = ffmpeg_tools.find()


def project(**changes):
    return {"id": "0123456789ab", "title": "Motion", "look": "sport", "bpm": 120, "fps": 30, "aspects": ["16:9"],
            "beats": [{"id": "hook", "kind": "title", "bars": 2, "text": "Start here"},
                      {"id": "mid", "kind": "statement", "bars": 2, "text": "The middle"},
                      {"id": "end", "kind": "end", "bars": 2, "text": "Try it now"}],
            "music": {"mood": "calm", "volume": .6}, **changes}


def text_clip(cid="k1", start=1.0, length=3.0, **extra):
    return {"id": cid, "kind": "text", "start": start, "in": 0, "out": length, "text": "Hello there",
            "box": {"x": .1, "y": .1, "w": .5, "h": .15}, **extra}


def overlay(*clips, **extra):
    return {"id": extra.pop("id", "t1"), "kind": "overlay", "name": extra.pop("name", "Titles"), "clips": list(clips), **extra}


def make(**changes):
    p = project(**changes)
    return video_store.create(**{k: v for k, v in p.items() if k != "id"}, owner="alice", chat_key_="chat-alice")


def test_video_file(folder, seconds=2.0, size="320x240", audio=True, rate=25):
    """A small MP4 made by FFmpeg's own test sources (a moving pattern and a tone), standing in for the person's file."""
    out = Path(folder) / "clip.mp4"
    args = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=660:duration={seconds}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"] + (["-c:a", "aac", "-shortest"] if audio else []) + [str(out)]
    subprocess.run(args, check=True, capture_output=True)
    return out


class KeyframeSchemaTests(unittest.TestCase):
    def bad(self, p, path):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn(path + ":", str(caught.exception))

    def test_keys_scale_and_rotation(self):
        keys = {"x": [{"t": 2, "v": .4}, {"t": 0, "v": -.5, "ease": "out"}], "rotation": [{"t": 1, "v": 720}]}
        p = video_store.validate(project(tracks=[overlay(text_clip(keys=keys, scale=1.5, rotation=0))]))
        clip = p["tracks"][0]["clips"][0]
        self.assertEqual(clip["keys"]["x"], [{"t": 0.0, "v": -.5, "ease": "out"}, {"t": 2.0, "v": .4, "ease": "linear"}], "sorted, ease filled in")
        self.assertEqual(clip["scale"], 1.5)
        self.assertNotIn("rotation", clip, "a plain value at its default is not stored")
        plain = video_store.validate(project(tracks=[overlay(text_clip())]))
        self.assertNotIn("keys", plain["tracks"][0]["clips"][0], "a clip without keys stays as it was")
        self.bad(project(tracks=[overlay(text_clip(keys={"colour": [{"t": 0, "v": 1}]}))]), "tracks[0].clips[0].keys.colour")
        self.bad(project(tracks=[overlay(text_clip(keys={"opacity": [{"t": 0, "v": 2}]}))]), "tracks[0].clips[0].keys.opacity[0].v")
        self.bad(project(tracks=[overlay(text_clip(keys={"x": [{"t": 1, "v": 0}, {"t": 1.001, "v": .2}]}))]), "tracks[0].clips[0].keys.x")
        self.bad(project(tracks=[overlay(text_clip(keys={"x": [{"t": 1, "v": 0, "ease": "bounce"}]}))]), "tracks[0].clips[0].keys.x[0].ease")
        self.bad(project(tracks=[overlay(text_clip(scale=20))]), "tracks[0].clips[0].scale")
        sound = {"id": "s1", "kind": "sound", "start": 0, "in": 0, "out": 1, "audio": "assets/" + "a" * 64 + ".wav", "keys": {}}
        self.bad(project(tracks=[{"id": "a", "kind": "audio", "clips": [sound]}]), "tracks[0].clips[0].keys")

    def test_key_ops_for_people_and_kairos(self):
        p = video_store.validate(project(tracks=[overlay(text_clip(start=1, length=3, **{"in": .5, "out": 3.5}))]))
        out = video_tools.edit(p, [{"op": "clip_key", "id": "k1", "prop": "x", "at": 1, "value": -.4, "ease": "out"},
                                   {"op": "clip_key", "id": "k1", "prop": "x", "at": 2, "value": .1},
                                   {"op": "clip_key", "id": "k1", "prop": "opacity", "at": 1, "value": 0}], agent=True)
        keys = out["tracks"][0]["clips"][0]["keys"]
        self.assertEqual(keys["x"], [{"t": .5, "v": -.4, "ease": "out"}, {"t": 1.5, "v": .1, "ease": "linear"}], "in the clip's own time (in 0.5)")
        replaced = video_tools.edit(out, [{"op": "clip_key", "id": "k1", "prop": "x", "at": 2, "value": .2}])
        self.assertEqual(len(replaced["tracks"][0]["clips"][0]["keys"]["x"]), 2, "a key at the same moment is replaced")
        gone = video_tools.edit(out, [{"op": "clip_unkey", "id": "k1", "at": 1}])["tracks"][0]["clips"][0]["keys"]
        self.assertEqual(list(gone), ["x"], "unkey at a time takes every property's key there")
        none = video_tools.edit(out, [{"op": "clip_unkey", "id": "k1", "prop": "x"}, {"op": "clip_unkey", "id": "k1", "prop": "opacity"}])
        self.assertNotIn("keys", none["tracks"][0]["clips"][0])
        with self.assertRaisesRegex(ValueError, "inside the clip"):
            video_tools.edit(out, [{"op": "clip_key", "id": "k1", "prop": "x", "at": 9, "value": 0}])
        locked = copy.deepcopy(out); locked["tracks"][0]["locked"] = True
        with self.assertRaisesRegex(ValueError, "locked"):
            video_tools.edit(locked, [{"op": "clip_key", "id": "k1", "prop": "y", "at": 2, "value": .3}], agent=True)
        # A split keeps the keys on both halves, in the clip's own time, so the motion carries across the cut.
        cut = video_tools.edit(out, [{"op": "clip_split", "id": "k1", "at": 2.5}])["tracks"][0]["clips"]
        self.assertEqual(cut[0]["keys"], cut[1]["keys"])
        self.assertIn("x 0.5s=-0.4(out) 1.5s=0.1", "\n".join(video_tracks.outline_lines(out)))
        self.assertIn("clip_key", video_tracks.OP_HELP)

    def test_ask_kairos_sets_keyframes(self):
        p = make(tracks=[overlay(text_clip())])

        class StandIn:
            prompts = []
            async def __call__(self, text, endpoint_id=None):
                self.prompts.append(text)
                return json.dumps({"reply": "It slides in from the left.", "ops": [
                    {"op": "clip_key", "id": "k1", "prop": "x", "at": 1, "value": -.5, "ease": "out"},
                    {"op": "clip_key", "id": "k1", "prop": "x", "at": 1.6, "value": .1}]})
        model = StandIn()
        result = asyncio.run(video_agent.ask(p["id"], "Slide the title in from the left", {"clips": ["k1"], "time": 1}, [], model=model))
        self.assertEqual(result["status"], "applied", result)
        self.assertIn("keyframes", result["changes"][0]["words"])
        self.assertEqual([k["v"] for k in video_store.get(p["id"])["tracks"][0]["clips"][0]["keys"]["x"]], [-.5, .1])
        self.assertIn("clip_key", model.prompts[0])
        undone = video_agent.undo(p["id"], result["id"])
        self.assertEqual(undone["run"]["status"], "undone")
        self.assertNotIn("keys", video_store.get(p["id"])["tracks"][0]["clips"][0])


class FrameRateTests(unittest.TestCase):
    def test_sixty_frames_a_second(self):
        p = video_store.validate(project(fps=60))
        self.assertEqual(video_store.frame_count(p), 720)
        self.assertEqual(video_store.frame_count(video_store.validate(project())), 360)
        with self.assertRaisesRegex(ValueError, "fps: use 30 or 60"):
            video_store.validate(project(fps=24))
        made = make(fps=60)
        job = video_render._job(made, "16:9", "j1", frame_times=[.5])
        self.assertEqual((job["fps"], job["frames"]), (60, 720))
        say = lambda n: {"say": f"Line {n} is spoken here.", "spoken": None}
        beats = [{"id": f"b{n}", "kind": "statement", "text": f"Point {n}", "bars": 1, "say": f"Line {n} is spoken here."} for n in range(4)]
        long = video_store.validate(project(fps=60, beats=beats, chapters=[{"id": "c1", "title": "One", "start": "b0"}, {"id": "c2", "title": "Two", "start": "b2"}],
                                            narration={"voice": "af_heart", "captions": True}))
        spans = video_store.chapter_spans(long)
        self.assertEqual(sum(s["frames"] for s in spans), video_store.frame_count(long), "the parts hold every frame at 60 too")
        self.assertEqual(spans[1]["first_frame"], round(spans[1]["start"] * 60))
        thirty = dict(long, fps=30)
        self.assertNotEqual(video_longform.chapter_keys(long, "16:9", "threejs"), video_longform.chapter_keys(thirty, "16:9", "threejs"),
                            "a 60 fps part is never reused for 30")
        encoder = ffmpeg_tools.Encoder.__init__.__code__.co_varnames
        self.assertIn("fps", encoder)
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        self.assertIn("![30, 60].includes(job.fps)", worker)
        self.assertIn("info.fps !== job.fps", worker)

    def test_channel_frame_rate(self):
        from services.content_studio import store as cs_store
        source = Path(cs_store.__file__).read_text(encoding="utf-8")
        self.assertIn('"fps": "INTEGER"', source)
        self.assertIn("the frame rate is 30 or 60 frames a second", source)


@unittest.skipUnless(FFMPEG, "FFmpeg is not installed")
class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="export-"))
        source = test_video_file(cls.folder, seconds=3, size="640x360", rate=30)
        cls.master = cls.folder / "16-9-v1.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(source), *ffmpeg_tools.VIDEO_ARGS, *ffmpeg_tools.AUDIO_ARGS, str(cls.master)],
                       check=True, capture_output=True)

    def probe(self, path):
        return subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True).stderr.decode("utf-8", "replace")

    def test_webm_mov_gif(self):
        webm = video_export.make(self.master, "webm")
        info = self.probe(self.folder / webm["file"])
        self.assertIn("Video: vp9", info); self.assertIn("Audio: opus", info)
        mov = video_export.make(self.master, "mov")
        info = self.probe(self.folder / mov["file"])
        self.assertIn("Video: h264", info); self.assertIn("Audio: aac", info); self.assertIn("mov,mp4", info)
        gif = video_export.make(self.master, "gif", 0, 2, cap_mb=15)
        self.assertEqual((gif["fps"], gif["long_side"]), (15, 720), "a short clip keeps the best step")
        self.assertIn("Video: gif", self.probe(self.folder / gif["file"]))
        small = video_export.gif(self.master, self.folder / "small.gif", 0, 3, cap_mb=.25)
        self.assertLessEqual(small["bytes"], .25 * 1024 * 1024)
        self.assertGreater(len(small["tries"]), 1, "a tight cap steps down the ladder")
        with self.assertRaisesRegex(ValueError, "at most 60 seconds"):
            video_export.gif(self.master, self.folder / "long.gif", 0, 61)
        with self.assertRaisesRegex(ValueError, "mp4 is the normal render"):
            video_export.start("0123456789ab", "16:9", "mp4")

    def test_route_and_download_names(self):
        app = FastAPI(); app.include_router(video_routes.router); app.dependency_overrides[require_user] = lambda: "alice"
        client = TestClient(app)
        p = make()
        bad = client.post(f"/api/videos/{p['id']}/render", json={"aspect": "16:9", "format": "avi"})
        self.assertEqual(bad.status_code, 422)
        long_gif = client.post(f"/api/videos/{p['id']}/render", json={"aspect": "16:9", "format": "gif", "start": 0, "end": 1})
        self.assertNotEqual(long_gif.status_code, 422, long_gif.text)
        renders = video_store._folder(p["id"]) / "renders"
        for name in ("16-9-v1.webm", "16-9-v1.mov", "16-9-v1.gif"):
            (renders / name).write_bytes(b"x")
            self.assertEqual(client.get(f"/api/videos/{p['id']}/renders/{name}").status_code, 200, name)
        self.assertEqual(client.get(f"/api/videos/{p['id']}/renders/16-9-v1.avi").status_code, 404)


@unittest.skipUnless(FFMPEG, "FFmpeg is not installed")
class MediaTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI(); self.app.include_router(video_routes.router); self.app.dependency_overrides[require_user] = lambda: "alice"
        self.client = TestClient(self.app)
        self.p = make()
        self.folder = Path(tempfile.mkdtemp(prefix="media-"))

    def test_upload_decodes_frames_and_its_sound(self):
        raw = test_video_file(self.folder, seconds=2, size="1920x1080", rate=25).read_bytes()
        response = self.client.post(f"/api/videos/{self.p['id']}/assets", files={"file": ("waves.mp4", raw, "video/mp4")})
        self.assertEqual(response.status_code, 200, response.text)
        made = response.json()["media"]
        self.assertRegex(made["media"], r"^media/[a-f0-9]{64}$")
        self.assertEqual(made["frames"], 60, "2 seconds at 30 frames a second, whatever the file's own rate")
        self.assertEqual((made["width"], made["height"]), (1280, 720), "at most 1280 pixels on the long side")
        self.assertRegex(made["audio"], r"^assets/[a-f0-9]{64}\.wav$", "its sound is a sound asset")
        self.assertIn(made["audio"], video_store.audio_info(self.p["id"]))
        sha = made["media"][6:]
        frame = self.client.get(f"/api/videos/{self.p['id']}/assets/media/{sha}/59.jpg")
        self.assertEqual(frame.status_code, 200); self.assertTrue(frame.content.startswith(b"\xff\xd8"))
        self.assertEqual(self.client.get(f"/api/videos/{self.p['id']}/assets/media/{sha}/60.jpg").status_code, 404)
        self.assertEqual(self.client.get(f"/api/videos/{self.p['id']}/assets/media/{sha}/..%2F..%2Fproject.json").status_code, 404)
        self.assertEqual(self.client.get(f"/api/videos/{self.p['id']}/media").json()["media"][made["media"]]["frames"], 60)
        # A clip of it: checked against the file's length; the player page gets its frame count.
        clip = {"id": "v1", "kind": "video", "start": 1, "in": .5, "out": 2, "video": made["media"], "box": {"x": .5, "y": .1, "w": .4, "h": .4}}
        saved = video_store.save(self.p["id"], dict(video_store.get(self.p["id"]), tracks=[overlay(clip)]))
        self.assertEqual(saved["tracks"][0]["clips"][0]["fit"], "cover")
        self.assertEqual(video_media.player_media(saved), {sha: {"frames": 60, "width": 1280, "height": 720}})
        with self.assertRaisesRegex(ValueError, "seconds long"):
            video_store.save(self.p["id"], dict(saved, tracks=[overlay(dict(clip, out=3))]))
        with self.assertRaisesRegex(ValueError, "no such video file"):
            video_store.save(self.p["id"], dict(saved, tracks=[overlay(dict(clip, video="media/" + "0" * 64))]))
        page = video_routes.player_page(saved)
        self.assertIn('"media": {"' + sha, page)

    def test_same_file_same_frames(self):
        raw = test_video_file(self.folder, seconds=1, audio=False, rate=30).read_bytes()
        first = video_media.add_video(self.p["id"], raw, "mp4", "one")
        self.assertIsNone(first["audio"], "a silent file has no sound")
        sha = first["media"][6:]
        hashes = [hashlib.sha256(video_media.frame_path(self.p["id"], sha, n).read_bytes()).hexdigest() for n in range(first["frames"])]
        other = make()
        again = video_media.add_video(other["id"], raw, "mp4", "two")
        self.assertEqual([hashlib.sha256(video_media.frame_path(other["id"], sha, n).read_bytes()).hexdigest() for n in range(again["frames"])], hashes,
                         "decoding the same file gives the same frames")
        self.assertEqual(len(set(hashes)), len(hashes), "every frame of the moving pattern differs")

    def test_limits(self):
        with self.assertRaisesRegex(ValueError, "MP4, MOV"):
            video_media.add_video(self.p["id"], b"abc", "avi")
        with self.assertRaisesRegex(ValueError, "could not be read|no picture"):
            video_media.add_video(self.p["id"], b"not a video at all" * 100, "mp4")
        with self.assertRaisesRegex(ValueError, "under 200 MB"):
            video_media.add_video(self.p["id"], b"0" * (video_media.UPLOAD_LIMIT + 1), "mp4")
        long = test_video_file(self.folder, seconds=62, size="160x90", audio=False, rate=10).read_bytes()
        made = video_media.add_video(self.p["id"], long, "mp4", "long")
        self.assertEqual(made["frames"], 1800, "the first 60 seconds are kept")
        self.assertTrue(made["cut"])

    def test_engine_frame_lookup_is_a_whole_number(self):
        engine = (ROOT / "static/motion/overlay.js").read_text(encoding="utf-8")
        self.assertIn("Math.floor((clip.in + (t - clip.start)) * MEDIA_FPS + 1e-6)", engine)
        self.assertEqual(video_media.FPS, 30)
        worker = (ROOT / "electron/designRender.js").read_text(encoding="utf-8")
        self.assertIn("assets\\/media\\/[a-f0-9]{64}\\/\\d{1,6}\\.jpg$", worker)


class WordCaptionFieldTests(unittest.TestCase):
    def narrated(self, **spoken):
        beat = {"id": "b1", "kind": "statement", "text": "Sky", "bars": 1, "say": "Look up on a clear day."}
        p = video_store.validate(project(beats=[beat], narration={"voice": "af_heart", "captions": True, "caption_style": "box"}))
        key = video_store.speech_key("af_heart", beat["say"])
        beat["spoken"] = {"key": key, "seconds": 2.2, "parts": [[.25, 2.45, "Look up on a clear day."]], **spoken}
        return video_store.validate(dict(p, beats=[beat]))

    def test_caption_style_and_words(self):
        p = self.narrated(words=[[.3, .5], [.5, .7], [.8, 1], [1, 1.2], [1.3, 1.7], [1.8, 2.4]], align={"method": "whisper.cpp base.en", "confidence": 1.0})
        self.assertEqual(p["narration"]["caption_style"], "box")
        self.assertTrue(video_store.word_captions(p))
        self.assertEqual(len(p["beats"][0]["spoken"]["words"]), 6)
        line = video_store.validate(project(narration={"voice": "af_heart", "captions": True, "caption_style": "line"}))
        self.assertNotIn("caption_style", line["narration"], "the default line style is not stored")
        with self.assertRaisesRegex(ValueError, "narration.caption_style"):
            video_store.validate(project(narration={"voice": "af_heart", "captions": True, "caption_style": "karaoke"}))
        for bad in ([[.3, .5]], [[.5, .3]] * 6, [[.3, .5], [.2, .4], [.8, 1], [1, 1.2], [1.3, 1.7], [1.8, 2.4]], [[.3, 9]] * 6):
            with self.assertRaisesRegex(ValueError, "spoken"):
                self.narrated(words=bad)
        with self.assertRaisesRegex(ValueError, "spoken"):
            self.narrated(align={"method": "x", "confidence": 3})

    def test_engine_reads_the_same_words(self):
        layout = (ROOT / "static/motion/layout.js").read_text(encoding="utf-8")
        self.assertIn("export const CAPTION_STYLES = ['line', 'highlight', 'box'];", layout)
        self.assertEqual(video_store.CAPTION_STYLES, ("line", "highlight", "box"))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        fixture.cleanup()
