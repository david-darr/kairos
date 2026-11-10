"""Content Studio editor steps 3 and 4: tracks and clips over the beats, the sound mix, the clip checks, the agent loop
(with a stand-in model) and the app page's import map under its Content-Security-Policy. No network, no real model."""
import asyncio
import base64
import copy
import hashlib
import io
import json
import os
import re
import sys
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="video-tracks-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
import numpy as np
from PIL import Image, ImageDraw
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient
from core import (ffmpeg_tools, middleware, three_vendor, video_agent, video_audio, video_checks, video_longform, video_store,
                  video_tools, video_tracks)
from core.middleware import SecurityHeadersMiddleware, require_user
from routes import video_routes

PNG = "assets/" + "a" * 64 + ".png"


def project(**changes):
    return {"id": "0123456789ab", "title": "Tracks", "look": "sport", "bpm": 120, "fps": 30, "aspects": ["16:9"],
            "beats": [{"id": "hook", "kind": "title", "bars": 2, "text": "Start here"},
                      {"id": "mid", "kind": "statement", "bars": 2, "text": "The middle"},
                      {"id": "end", "kind": "end", "bars": 2, "text": "Try it now"}],
            "music": {"mood": "calm", "volume": .6}, **changes}


def text_clip(cid="k1", start=1.0, length=2.0, **extra):
    return {"id": cid, "kind": "text", "start": start, "in": 0, "out": length, "text": "Hello there",
            "box": {"x": .1, "y": .1, "w": .5, "h": .15}, **extra}


def overlay(*clips, **extra):
    return {"id": extra.pop("id", "t1"), "kind": "overlay", "name": extra.pop("name", "Titles"), "clips": list(clips), **extra}


def make(**changes):
    p = project(**changes)
    return video_store.create(**{k: v for k, v in p.items() if k != "id"}, owner="alice", chat_key_="chat-alice")


def wav_bytes(seconds=1.0, freq=440.0, rate=44100, channels=1):
    t = np.arange(int(seconds * rate)) / rate
    data = (np.sin(2 * np.pi * freq * t) * 0.5 * 32767).astype("<i2")
    if channels == 2:
        data = np.repeat(data[:, None], 2, axis=1)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate); w.writeframes(data.tobytes())
    return out.getvalue()


def run(coro):
    return asyncio.run(coro)


class SchemaTests(unittest.TestCase):
    def bad(self, p, path):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(p)
        self.assertIn(path + ":", str(caught.exception))

    def test_old_videos_load_unchanged(self):
        p = project()
        self.assertEqual(video_store.validate(p), video_store.validate(copy.deepcopy(p)))
        self.assertNotIn("tracks", video_store.validate(p))
        self.assertNotIn("tracks", video_store.validate(project(tracks=[])))
        self.assertNotIn("tracks", video_store.validate(project(tracks=None)))

    def test_clip_defaults_and_order(self):
        p = video_store.validate(project(tracks=[overlay(text_clip("b2", 3), text_clip("a1", 0, 1))]))
        clips = p["tracks"][0]["clips"]
        self.assertEqual([c["id"] for c in clips], ["a1", "b2"])
        self.assertEqual((clips[0]["opacity"], clips[0]["style"], clips[0]["role"], clips[0]["color"], clips[0]["align"]),
                         (1.0, "card", "title", "text", "center"))
        self.assertEqual(p["tracks"][0]["hidden"], False)
        self.assertEqual(p["tracks"][0]["locked"], False)

    def test_field_errors_name_the_field(self):
        self.bad(project(tracks=[overlay(text_clip(), text_clip("k2", 2))]), "tracks[0].clips")       # overlap
        self.bad(project(tracks=[overlay(text_clip(colour="red"))]), "tracks[0].clips[0].colour")
        self.bad(project(tracks=[overlay(text_clip(box={"x": .8, "y": .1, "w": .5, "h": .1}))]), "tracks[0].clips[0].box")
        self.bad(project(tracks=[overlay(text_clip(fade_in=1.5, fade_out=1))]), "tracks[0].clips[0].fade_in")
        self.bad(project(tracks=[overlay(text_clip(text=""))]), "tracks[0].clips[0].text")
        self.bad(project(tracks=[overlay(text_clip("hook"))]), "tracks[0].clips[0].id")              # a beat's id
        self.bad(project(tracks=[overlay(text_clip(out=0))]), "tracks[0].clips[0].out")
        self.bad(project(tracks=[{"id": "a", "kind": "audio", "name": "Sound", "clips": [text_clip()]}]), "tracks[0].clips[0].kind")
        self.bad(project(tracks=[overlay(), overlay()]), "tracks[1].id")
        self.bad(project(tracks=[overlay(id="t1", name="<b>")]), "tracks[0].name")
        sound = {"id": "s1", "kind": "sound", "start": 0, "in": 0, "out": 1, "audio": "assets/" + "b" * 64 + ".wav"}
        self.bad(project(tracks=[{"id": "a", "kind": "audio", "clips": [sound]}]), "tracks[0].clips[0].audio")
        self.bad(project(tracks=[overlay(dict(text_clip(), kind="image", image="x.png"))]), "tracks[0].clips[0].text")

    def test_api_body_round_trips_tracks(self):
        body = video_routes.VideoBody(**{k: v for k, v in project(tracks=[overlay(text_clip())]).items() if k != "id"})
        self.assertEqual(body.project()["tracks"][0]["clips"][0]["text"], "Hello there")
        self.assertNotIn("tracks", video_routes.VideoBody(**{k: v for k, v in project().items() if k != "id"}).project())


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.p = video_store.validate(project(tracks=[overlay(text_clip()), overlay(id="t2", name="Shapes")]))

    def test_split_trim_move_and_ripple(self):
        p = video_tools.edit(self.p, [{"op": "clip_split", "id": "k1", "at": 2.0}])
        first, second = p["tracks"][0]["clips"]
        self.assertEqual((first["start"], first["in"], first["out"]), (1.0, 0.0, 1.0))
        self.assertEqual((second["start"], second["in"], second["out"]), (2.0, 1.0, 2.0))
        p = video_tools.edit(p, [{"op": "clip_trim", "id": second["id"], "start": 2.5, "end": 3.5}])
        moved = p["tracks"][0]["clips"][1]
        self.assertEqual((moved["start"], moved["in"], moved["out"]), (2.5, 1.5, 2.5))
        p = video_tools.edit(p, [{"op": "clip_move", "id": "k1", "track": "t2", "start": 4}])
        self.assertEqual([c["id"] for c in p["tracks"][1]["clips"]], ["k1"])
        p = video_tools.edit(p, [{"op": "clip_add", "track": "t2", "clip": text_clip("k9", 6, 1)}, {"op": "clip_remove", "id": "k1", "ripple": True}])
        self.assertEqual(p["tracks"][1]["clips"][0]["start"], 5.0)
        with self.assertRaisesRegex(ValueError, "inside the clip"):
            video_tools.edit(p, [{"op": "clip_split", "id": "k9", "at": 9}])

    def test_locked_tracks_and_the_agent(self):
        p = video_tools.edit(self.p, [{"op": "track_set", "id": "t1", "field": "locked", "value": True}])
        for op in ({"op": "clip_set", "id": "k1", "field": "text", "value": "x"}, {"op": "clip_remove", "id": "k1"},
                   {"op": "track_remove", "id": "t1"}, {"op": "clip_add", "track": "t1", "clip": text_clip("k5", 5, 1)},
                   {"op": "clip_move", "id": "k1", "start": 3}):
            with self.assertRaisesRegex(ValueError, "locked"):
                video_tools.edit(p, [op])
        with self.assertRaisesRegex(ValueError, "only the person"):
            video_tools.edit(p, [{"op": "track_set", "id": "t1", "field": "locked", "value": False}], agent=True)
        self.assertFalse(video_tools.edit(p, [{"op": "track_set", "id": "t1", "field": "locked", "value": False}])["tracks"][0]["locked"])

    def test_moves_keep_kinds_and_tracks_add(self):
        p = video_tools.edit(self.p, [{"op": "track_add", "track": {"kind": "audio", "name": "Sound"}}])
        self.assertEqual(p["tracks"][-1]["kind"], "audio")
        with self.assertRaisesRegex(ValueError, "another overlay track"):
            video_tools.edit(p, [{"op": "clip_move", "id": "k1", "track": p["tracks"][-1]["id"]}])
        with self.assertRaisesRegex(ValueError, "track_ or clip_"):
            video_tools.edit(p, [{"op": "explode"}])

    def test_outline_and_timeline_views(self):
        lines = "\n".join(video_tracks.outline_lines(self.p))
        self.assertIn("Track t1 (overlay, \"Titles\")", lines)
        self.assertIn("clip k1 1-3s text \"Hello there\"", lines)
        view = video_tracks.timeline(self.p)
        self.assertEqual([t["id"] for t in view["tracks"]], ["beats", "t1", "t2"])
        self.assertEqual(view["tracks"][0]["clips"][1]["start"], 4.0)
        self.assertEqual(view["tracks"][1]["clips"][0]["end"], 3.0)


class LongformKeyTests(unittest.TestCase):
    def test_a_clip_changes_only_its_chapters_key(self):
        beats = [{"id": f"b{i}", "kind": "statement", "bars": 1, "text": f"Point {i}", "say": f"Line number {i} is spoken here."} for i in range(4)]
        base = project(beats=beats, chapters=[{"id": "c1", "title": "One", "start": "b0"}, {"id": "c2", "title": "Two", "start": "b2"}])
        plain = video_store.validate(base)
        with_empty = video_store.validate(dict(copy.deepcopy(base), tracks=[]))
        self.assertEqual(video_longform.chapter_keys(plain, "16:9", "threejs"), video_longform.chapter_keys(with_empty, "16:9", "threejs"))
        spans = video_store.chapter_spans(plain)
        late = spans[1]["start"] + .5
        clipped = video_store.validate(dict(copy.deepcopy(base), tracks=[overlay(text_clip(start=late, length=.5))]))
        a, b = video_longform.chapter_keys(plain, "16:9", "threejs"), video_longform.chapter_keys(clipped, "16:9", "threejs")
        self.assertEqual(a[0], b[0])
        self.assertNotEqual(a[1], b[1])
        hidden = copy.deepcopy(clipped); hidden["tracks"][0]["hidden"] = True
        self.assertEqual(video_longform.chapter_keys(hidden, "16:9", "threejs")[0], a[0])


@unittest.skipUnless(ffmpeg_tools.find(), "FFmpeg is not installed")
class SoundTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(video_routes.router)
        self.app.dependency_overrides[require_user] = lambda: "alice"
        self.client = TestClient(self.app)
        self.p = make()

    def upload(self, raw, name):
        return self.client.post(f"/api/videos/{self.p['id']}/assets", files={"file": (name, raw, "application/octet-stream")})

    def test_upload_decodes_measures_and_mixes(self):
        response = self.upload(wav_bytes(1.0), "beep.wav")
        self.assertEqual(response.status_code, 200, response.text)
        asset = response.json()["asset"]
        self.assertRegex(asset, r"^assets/[a-f0-9]{64}\.wav$")
        info = self.client.get(f"/api/videos/{self.p['id']}/audio").json()["sounds"][asset]
        self.assertAlmostEqual(info["seconds"], 1.0, places=2)
        self.assertEqual(info["title"], "beep")
        self.assertEqual(len(base64.b64decode(info["peaks"])), 40)
        with wave.open(str(video_store.asset_path(self.p["id"], asset[7:])), "rb") as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (48000, 2, 2))
        # A file that is not a sound, and a sound past the file's end, are refused.
        self.assertEqual(self.upload(b"not a sound at all" * 50, "fake.mp3").status_code, 422)
        # An MP3 the person exports from another program decodes the same way.
        import subprocess, tempfile
        folder = Path(tempfile.mkdtemp(prefix="mp3-"))
        (folder / "in.wav").write_bytes(wav_bytes(.6, 660))
        made = subprocess.run([ffmpeg_tools.find(), "-v", "error", "-i", str(folder / "in.wav"), str(folder / "out.mp3")], capture_output=True)
        if made.returncode == 0:
            mp3 = self.upload((folder / "out.mp3").read_bytes(), "tone.mp3")
            self.assertEqual(mp3.status_code, 200, mp3.text)
            self.assertAlmostEqual(mp3.json()["audio"]["seconds"], .6, delta=.08)
        too_long = {"id": "s1", "kind": "sound", "start": 0, "in": 0, "out": 2, "audio": asset}
        with self.assertRaisesRegex(ValueError, "seconds long"):
            video_store.save(self.p["id"], dict(video_store.get(self.p["id"]), tracks=[{"id": "a", "kind": "audio", "clips": [too_long]}]))
        clip = {"id": "s1", "kind": "sound", "start": 2.0, "in": 0.25, "out": 0.75, "volume": 1, "fade_in": 0, "fade_out": .1, "audio": asset}
        saved = video_store.save(self.p["id"], dict(video_store.get(self.p["id"]), tracks=[{"id": "a", "kind": "audio", "clips": [clip]}]))
        mixed, report = video_audio.synthesize(saved, {}), {}
        plain = video_audio.synthesize(dict(saved, tracks=[]))
        muted = copy.deepcopy(saved); muted["tracks"][0]["hidden"] = True
        self.assertTrue(np.array_equal(video_audio.synthesize(muted), plain))
        video_audio.synthesize(saved, report)
        self.assertEqual(report["sound_clips"], 1)
        sr = video_audio.SR
        inside = np.abs(mixed[int(2.1 * sr):int(2.3 * sr)] - plain[int(2.1 * sr):int(2.3 * sr)]).max()
        outside = np.abs(mixed[int(1.0 * sr):int(1.9 * sr)] - plain[int(1.0 * sr):int(1.9 * sr)]).max()
        self.assertGreater(inside, .1)
        self.assertLess(outside, 1e-6)
        self.assertTrue(np.array_equal(mixed, video_audio.synthesize(saved)))     # deterministic
        self.assertLessEqual(float(np.abs(mixed).max()), video_audio.MIX_PEAK + 1e-6)


class CheckTests(unittest.TestCase):
    def test_static_clip_notes(self):
        p = video_store.validate(project(tracks=[overlay(text_clip(start=11.5, length=2), text_clip("k2", 0, .5, text="Far too many words for half a second"))]))
        notes = "\n".join(video_checks.overlay_notes(p))
        self.assertIn("Clip k1 on Titles runs past the end of the video", notes)
        self.assertIn("Clip k2 on Titles reads faster than 3.5 words/s", notes)

    def test_layout_notes_and_plain_contrast_on_frame(self):
        p = video_store.validate(project(tracks=[overlay(text_clip(style="plain", color="dim"))]))
        layouts = [{"time": 1.5, "elements": [
            {"clip": "k1", "kind": "text", "text": "Hello th...", "truncated": True, "x": 10, "y": 900, "w": 900, "h": 120,
             "color": "rgb(120, 120, 120)", "bg": None},
            {"clip": "k1", "kind": "text", "text": "Hello", "x": 200, "y": 100, "w": 400, "h": 100, "color": "#777777", "bg": "#707070"}]}]
        image = Image.new("RGB", (1920, 1080), (110, 110, 110))
        ImageDraw.Draw(image).text((20, 910), "Hello", fill=(120, 120, 120))
        raw = io.BytesIO(); image.save(raw, "JPEG"); raw = raw.getvalue()
        notes = "\n".join(video_checks.overlay_notes(p, "16:9", layouts, [raw], [1.5]))
        self.assertIn("cut off with an ellipsis", notes)
        self.assertIn("outside the safe area", notes)
        self.assertIn("contrast under 4.5:1 on its card", notes)
        self.assertIn("contrast under 4.5:1 against what is behind it (at 1.5 s)", notes)
        # Beat checks leave clip boxes to these notes.
        self.assertFalse(any("Beat ?" in n for n in video_checks.check(p, "16:9", layouts)))

    def test_text_clip_frames_are_kept_for_the_checks(self):
        p = video_store.validate(project(tracks=[overlay(text_clip(start=1, length=2))]))
        self.assertEqual(video_tracks.check_frames(p, 0, 359), {60})


class StandIn:
    """A stand-in model: returns the next canned answer and keeps every prompt it was given."""
    def __init__(self, *answers):
        self.answers, self.prompts = list(answers), []

    async def __call__(self, text, endpoint_id=None):
        self.prompts.append(text)
        return json.dumps(self.answers.pop(0))


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.p = make(tracks=[overlay(text_clip())])
        self.id = self.p["id"]

    def test_comments_ask_apply_changes_since_and_undo(self):
        comment = video_agent.add_comment(self.id, t=1.5, x=.3, y=.2, text="Make this say Welcome", under='text "Hello there" (clip k1)')
        model = StandIn({"reply": "Changed the greeting.", "ops": [{"op": "clip_set", "id": "k1", "field": "text", "value": "Welcome"}],
                         "resolved": [comment["id"]]})
        result = run(video_agent.ask(self.id, "", {"clips": ["k1"], "time": 1.5}, [comment["id"]], model=model))
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["changes"][0]["words"], 'Changed clip k1 (text "Welcome"): text.')
        prompt = model.prompts[0]
        self.assertIn("UNTRUSTED", prompt)
        self.assertIn("Selected clip k1 (text \"Hello there\") on track t1", prompt)
        self.assertIn(f"{comment['id']} at 0:01.5, x 0.3 y 0.2 (on screen there: text \"Hello there\" (clip k1)): Make this say Welcome", prompt)
        self.assertEqual(video_store.get(self.id)["tracks"][0]["clips"][0]["text"], "Welcome")
        review = video_agent.review(self.id)
        self.assertEqual(review["comments"][0]["status"], "resolved")
        self.assertEqual(review["since"]["changes"], [])
        # The person edits after Kairos's turn: the next request sees it in plain words.
        current = video_store.get(self.id)
        current["beats"][1]["text"] = "A new middle"
        video_store.save(self.id, current)
        since = video_agent.changes_since_last_turn(self.id)["changes"]
        self.assertEqual([c["words"] for c in since], ['Changed beat mid (statement "A new middle"): text.'])
        model2 = StandIn({"reply": "Nothing to do.", "ops": []})
        run(video_agent.ask(self.id, "Anything else?", None, [], model=model2))
        self.assertIn('- Changed beat mid (statement "A new middle"): text.', model2.prompts[0])
        # Undo puts the clip back and reopens the comment; the person's own edit stays.
        out = video_agent.undo(self.id, result["id"])
        self.assertEqual(out["run"]["status"], "undone")
        now = video_store.get(self.id)
        self.assertEqual(now["tracks"][0]["clips"][0]["text"], "Hello there")
        self.assertEqual(now["beats"][1]["text"], "A new middle")
        self.assertEqual(video_agent.load(self.id)["comments"][0]["status"], "open")
        with self.assertRaisesRegex(ValueError, "Only an applied"):
            video_agent.undo(self.id, result["id"])

    def test_big_changes_wait_as_a_dry_run(self):
        ops = [{"op": "clip_add", "track": "t1", "clip": text_clip(f"n{i}", 4 + i, .5, text=f"Point {i}")} for i in range(6)]
        result = run(video_agent.ask(self.id, "Add six points", None, [], model=StandIn({"reply": "Six points.", "ops": ops})))
        self.assertEqual(result["status"], "pending")
        self.assertEqual(len(result["changes"]), 6)
        self.assertEqual(video_store.get(self.id)["version"], self.p["version"])           # nothing saved yet
        applied = video_agent.apply(self.id, result["id"])
        self.assertEqual(len(applied["project"]["tracks"][0]["clips"]), 7)
        again = run(video_agent.ask(self.id, "And again", None, [], model=StandIn({"reply": "x", "ops": [
            {"op": "clip_add", "track": "t1", "clip": text_clip(f"z{i}", 10.5 + i * .25, .25)} for i in range(6)]})))
        self.assertEqual(video_agent.discard(self.id, again["id"])["status"], "discarded")
        self.assertEqual(len(video_store.get(self.id)["tracks"][0]["clips"]), 7)

    def test_locked_tracks_fail_the_run_and_change_nothing(self):
        p = video_store.get(self.id); p["tracks"][0]["locked"] = True; video_store.save(self.id, p)
        version = video_store.get(self.id)["version"]
        result = run(video_agent.ask(self.id, "Change it", None, [], model=StandIn({"reply": "x", "ops": [
            {"op": "clip_set", "id": "k1", "field": "text", "value": "No"}]})))
        self.assertEqual(result["status"], "failed")
        self.assertIn("locked", result["error"])
        self.assertEqual(video_store.get(self.id)["version"], version)

    def test_undo_leaves_items_changed_again(self):
        result = run(video_agent.ask(self.id, "Two edits", None, [], model=StandIn({"reply": "x", "ops": [
            {"op": "clip_set", "id": "k1", "field": "text", "value": "One"}, {"op": "set", "id": "end", "field": "text", "value": "Bye"}]})))
        p = video_store.get(self.id); p["tracks"][0]["clips"][0]["text"] = "Mine"; video_store.save(self.id, p)
        out = video_agent.undo(self.id, result["id"])
        now = video_store.get(self.id)
        self.assertEqual(now["tracks"][0]["clips"][0]["text"], "Mine")
        self.assertEqual(now["beats"][2]["text"], "Try it now")
        self.assertEqual(out["run"]["conflicts"], ["Clip k1 changed again since; left as it is."])

    def test_diff_words_and_revert_round_trip(self):
        before = video_store.get(self.id)
        after = video_tools.edit(before, [{"op": "move", "id": "end", "before": "hook"}, {"op": "track_add", "track": {"kind": "overlay", "name": "New"}},
                                          {"op": "clip_move", "id": "k1", "start": 5}, {"op": "remove", "id": "mid"}, {"op": "project", "field": "title", "value": "Renamed"}])
        words = [c["words"] for c in video_agent.diff(before, after)]
        self.assertIn('Changed the video\'s title from "Tracks" to "Renamed".', words)
        self.assertIn('Removed beat mid (statement "The middle").', words)
        self.assertIn("Changed the order of the beats.", words)
        self.assertIn('Added the overlay track "New".', words)
        self.assertTrue(any(w.startswith("Changed clip k1") and "now 0:05.0 to 0:07.0" in w for w in words))
        reverted, conflicts, done = video_agent.revert(after, video_agent.diff(before, after))
        self.assertEqual(conflicts, [])
        self.assertEqual(video_store.validate(reverted), video_store.validate({k: v for k, v in before.items()}))

    def test_what_ask_kairos_may_not_change(self):
        for ops, words in (([{"op": "project", "field": "look", "value": "nordic"}], "stay your choice"),
                           ([{"op": "clip_add", "track": "t1", "clip": {"kind": "image", "id": "pic", "start": 5, "in": 0, "out": 1,
                                                                        "image": "assets/" + "c" * 64 + ".png"}}], "not one of this video's images")):
            result = run(video_agent.ask(self.id, "Try it", None, [], model=StandIn({"reply": "x", "ops": ops})))
            self.assertEqual(result["status"], "failed")
            self.assertIn(words, result["error"])
        self.assertEqual(video_store.get(self.id)["version"], self.p["version"])

    def test_bad_model_answers(self):
        with self.assertRaisesRegex(ValueError, "not answer with changes"):
            run(video_agent.ask(self.id, "x", None, [], model=lambda *a: asyncio.sleep(0, "plain words only")))
        with self.assertRaisesRegex(ValueError, "describe the change"):
            run(video_agent.ask(self.id, "", None, [], model=StandIn({})))

    def test_routes(self):
        app = FastAPI(); app.include_router(video_routes.router)
        app.dependency_overrides[require_user] = lambda: "alice"
        client = TestClient(app)
        made = client.post(f"/api/videos/{self.id}/comments", json={"t": 1, "x": .5, "y": .5, "text": "Bigger please"})
        self.assertEqual(made.status_code, 200, made.text)
        cid = made.json()["id"]
        self.assertEqual(client.patch(f"/api/videos/{self.id}/comments/{cid}", json={"text": "Much bigger"}).json()["text"], "Much bigger")
        with patch.object(video_agent, "ask_model", StandIn({"reply": "Bigger.", "ops": [{"op": "clip_set", "id": "k1", "field": "box",
                                                                                           "value": {"x": .1, "y": .1, "w": .6, "h": .2}}], "resolved": [cid]})):
            answer = client.post(f"/api/videos/{self.id}/agent/ask", json={"request": "", "comments": [cid]})
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertEqual(answer.json()["status"], "applied")
        self.assertNotIn("ops", answer.json())
        review = client.get(f"/api/videos/{self.id}/review").json()
        self.assertEqual(review["runs"][0]["id"], answer.json()["id"])
        self.assertEqual(client.post(f"/api/videos/{self.id}/agent/runs/{answer.json()['id']}/undo").json()["run"]["status"], "undone")
        self.assertEqual(client.post(f"/api/videos/{self.id}/agent/runs/x/explode").status_code, 404)
        self.assertEqual(client.delete(f"/api/videos/{self.id}/comments/{cid}").json(), {"ok": True})
        app.dependency_overrides[require_user] = lambda: "bob"
        with patch.object(video_routes.auth_manager, "is_admin", return_value=False):
            self.assertEqual(client.get(f"/api/videos/{self.id}/review").status_code, 404)
            self.assertEqual(client.post(f"/api/videos/{self.id}/comments", json={"t": 1, "x": .5, "y": .5, "text": "x"}).status_code, 404)


class AppPagePolicyTests(unittest.TestCase):
    """The app page runs one inline script, the three.js import map, allowed by its hash on that page only."""
    page = (ROOT / "static" / "index.html").read_text(encoding="utf-8")

    def test_the_map_is_the_only_inline_script_and_matches(self):
        scripts = re.findall(r"<script\b([^>]*)>(.*?)</script>", self.page, re.S)
        inline = [(attrs, body) for attrs, body in scripts if "src=" not in attrs]
        self.assertEqual(len(inline), 1)
        self.assertEqual(inline[0][1], three_vendor.IMPORT_MAP)
        self.assertEqual(self.page.count(three_vendor.IMPORT_MAP_TAG), 1)
        self.assertLess(self.page.index(three_vendor.IMPORT_MAP_TAG), self.page.index('src="/static/js/app.js"'))
        digest = base64.b64encode(hashlib.sha256(inline[0][1].encode("utf-8")).digest()).decode()
        self.assertEqual(three_vendor.csp_hash(), f"'sha256-{digest}'")

    def test_only_the_app_page_allows_it(self):
        app = FastAPI(); app.add_middleware(SecurityHeadersMiddleware)
        for path in ("/", "/api/x", "/static/index.html"):
            app.add_api_route(path, lambda: PlainTextResponse("ok"))
        client = TestClient(app)
        home = client.get("/").headers["Content-Security-Policy"]
        self.assertIn(f"script-src 'self' {three_vendor.csp_hash()};", home)
        self.assertNotIn("unsafe-inline';", home.split("script-src")[1].split(";")[0])
        for path in ("/api/x", "/static/index.html"):
            policy = client.get(path).headers["Content-Security-Policy"]
            self.assertIn("script-src 'self';", policy)
            self.assertNotIn("sha256", policy)

    def test_test_servers_use_the_same_hash(self):
        import subprocess
        out = subprocess.run(["node", "-e", "console.log(require('./scripts/app-page-policy.cjs').IMPORT_MAP_HASH)"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), three_vendor.csp_hash())

    def test_a_changed_map_gets_no_hash(self):
        with patch("builtins.open", side_effect=OSError):
            self.assertEqual(middleware._app_page_script_hashes(), "")
        self.assertEqual(middleware.APP_PAGE_SCRIPT_HASHES, " " + three_vendor.csp_hash())


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        fixture.cleanup()
