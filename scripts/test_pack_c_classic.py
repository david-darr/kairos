"""Pack C classic and the Story Short (David, 2026-11-10; Video Styles build spec, "Pack C classic as built").

- the JavaScript model (scripts/test_classic_model.mjs, run here when Node is present): textures, the mesher, the classic
  proportions, faces and moods, constant-key poses, cuts on words, effects, the split-screen layout, one-word captions,
  the mouth hold, the flashback grade and the distance rules in the code;
- block characters: `form: block` with an outfit, a speaker colour and a voice; the palette comes from the outfit; the
  starters Rook, Fenn and Juno are our own (none in another game's default colours or a named channel's characters);
  the body plan the checks use equals static/motion/classic.js; the block sheet passes its own checks;
- the Story Short: story beats validate with plain messages (9:16 only, story beats only, words in range, a block
  speaker), the timing is the line plus its gap (or the hold), each speaker's voice is its own cache key;
- voices: Kokoro at the speaker's speed, a pitch shift that keeps the length (a tone moves up by the semitones asked),
  trimmed silent edges, word times by letters when whisper.cpp cannot align;
- sound: the story mix's levels (dialogue median, the piano bed, the flashback dip), every effect synthesized, -14 LUFS;
- the pack: block-classic built in, its starter "Classic block story" (generic name, no game's name), its sample's story
  shape and length, the shipped format card "Story Short" (added once, never revived after the team retires it);
- the Evaluator's brand rule covers block-classic and refuses the named channel and its characters;
- the render notes: a shot over 2.5 s is named, story captions are one word.

No render worker runs here: video-render-smoke --story renders the real sample.
"""
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-pack-c-classic-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from core import (character_checks, character_sheet, character_store, ffmpeg_tools, style_pack_sample, style_pack_store,  # noqa: E402
                  style_packs, video_audio, video_checks, video_narration, video_store)


def _let_go():
    try:
        from services.content_studio import close_all
        close_all()
    except Exception:
        pass


import atexit  # noqa: E402
atexit.register(_let_go)
NODE = shutil.which("node")
FFMPEG = ffmpeg_tools.find()


def node_eval(code):
    return json.loads(subprocess.run([NODE, "--input-type=module", "-e", code], capture_output=True, text=True, check=True, cwd=ROOT).stdout)


def hue(hex_colour):
    import colorsys
    r, g, b = (int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h * 360, s, v


class Model(unittest.TestCase):
    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_the_classic_model_suite_passes(self):
        out = subprocess.run([NODE, str(ROOT / "scripts" / "test_classic_model.mjs")], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("checks passed", out.stdout)

    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_textures_and_worlds_are_the_same_in_two_separate_runs(self):
        code = ("import { TEXTURES, blockTexture, faceTexture } from './static/motion/blocks.js';"
                "import { worldModel, PLACES } from './static/motion/classic.js';"
                "import { createHash } from 'node:crypto';"
                "const h = v => createHash('sha256').update(v).digest('hex');"
                "const o = { skin: '#f0c8a8', hair: '#1d1a22', hair_style: 'tuft', shirt: '#5e2b8c', detail: '#e8e3f0', detail_style: 'zip', pants: '#2a2833', shoes: '#ececec', eyes: '#2d2140' };"
                "console.log(JSON.stringify([...TEXTURES.map(t => h(Buffer.from(blockTexture(t).data))), h(Buffer.from(faceTexture(o, 'crying', true).data)),"
                "...PLACES.map(p => h(JSON.stringify([...worldModel(p, 7).blocks])))]));")
        self.assertEqual(node_eval(code), node_eval(code))

    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_the_python_block_plan_matches_classic_js(self):
        plan = node_eval("import { blockPlan } from './static/motion/classic.js'; console.log(JSON.stringify(blockPlan()));")
        mine = character_checks.block_plan(character_store.starter_block("square"))
        for key in ("zb", "face", "zh", "br"):
            self.assertAlmostEqual(mine[key], plan[key], places=9, msg=key)
        self.assertAlmostEqual(mine["H"], plan["H"], places=9)


class Characters(unittest.TestCase):
    def test_block_characters_carry_an_outfit_a_colour_and_a_voice(self):
        rook = character_store.starter_block("square")
        self.assertEqual((rook["name"], rook["form"], rook["colour"]), ("Rook", "block", "#b05aff"))
        self.assertEqual(rook["voice"], {"id": "af_heart", "speed": 1.14, "pitch": 1.5})
        o = rook["outfit"]
        self.assertEqual(rook["palette"]["body"], o["shirt"])
        self.assertEqual(rook["palette"]["head"], o["skin"])
        self.assertEqual(rook["palette"]["limb"], o["pants"])
        self.assertEqual(rook["palette"]["accent"], rook["colour"])
        self.assertEqual(character_store.starter_for("block", "round")["voice"], {"id": "am_echo", "speed": 1.08, "pitch": 3.0})
        self.assertEqual(character_store.starter_for("block", "triangle")["voice"], {"id": "af_bella", "speed": 1.1, "pitch": 2.5})
        for bad, field in (({"outfit": {**o, "hair_style": "mohawk"}}, "outfit.hair_style"), ({"outfit": {**o, "shirt": "purple"}}, "outfit.shirt"),
                           ({"voice": {"id": "af_heart", "speed": 2, "pitch": 0}}, "voice.speed"), ({"voice": {"id": "af_heart", "pitch": 9}}, "voice.pitch"),
                           ({"colour": "violet"}, "colour")):
            with self.assertRaisesRegex(ValueError, field.replace(".", r"\.")):
                character_store.merged(rook, bad)
        with self.assertRaisesRegex(ValueError, "only a block character"):
            character_store.validate({**character_store.starter("round"), "outfit": o})

    def test_the_starters_are_our_own_looks(self):
        """No starter in another game's default colours (a cyan shirt over blue pants; a green shirt with orange hair) or a named
        channel's characters (a blue hoodie; a green turtle-shell look): checked on the outfits' hues."""
        for family in character_store.FAMILIES:
            o = character_store.starter_block(family)["outfit"]
            shirt, pants, hair = hue(o["shirt"]), hue(o["pants"]), hue(o["hair"])
            cyan_shirt = 170 <= shirt[0] <= 210 and shirt[1] > .35
            blue_pants = 200 <= pants[0] <= 250 and pants[1] > .35
            green_shirt = 80 <= shirt[0] <= 160 and shirt[1] > .3
            orange_hair = 15 <= hair[0] <= 40 and hair[1] > .5 and hair[2] > .45
            self.assertFalse(cyan_shirt and blue_pants, family)
            self.assertFalse(green_shirt and orange_hair, family)
            self.assertFalse(200 <= shirt[0] <= 250 and shirt[1] > .35, f"{family}: no blue shirt or hoodie")
            self.assertFalse(green_shirt, f"{family}: no green shirt")
        names = {character_store.starter_block(f)["name"] for f in character_store.FAMILIES}
        self.assertEqual(names, {"Rook", "Fenn", "Juno"})
        self.assertFalse(names & {"Steve", "Alex", "JJ", "Mikey"})

    def test_the_block_sheet_uses_the_3d_layout_and_its_checks(self):
        cid = character_store.create(character_store.starter_block("square", name="Rook Sheet"), by="test")["id"]
        spec = character_store.spec(cid, 1)
        self.assertIs(character_sheet.layout_for(spec), character_sheet.LAYOUT_3D)
        self.assertIn("sheet3d.js", character_sheet.page(cid, 1))
        layout = character_sheet.LAYOUT_3D
        im = Image.new("RGB", (layout["w"], layout["h"]), layout["background"])
        d = ImageDraw.Draw(im)
        plan, P = character_checks.block_plan(spec), 1 / 16
        for cell in (layout["key"], next(c for c in layout["views"] if c["view"] == "front")):
            px = cell["height"] / plan["H"]
            cx, feet = cell["x"] + cell["w"] / 2, cell["feet"]
            y = lambda z: feet - z * px   # noqa: E731
            d.rectangle([cx - 8 * P * px, y(24 * P), cx + 8 * P * px, y(12 * P)], fill=spec["palette"]["body"])     # torso and sleeves
            d.rectangle([cx - 4 * P * px, y(32 * P), cx + 4 * P * px, y(24 * P)], fill=spec["palette"]["head"])
            d.rectangle([cx - 4 * P * px, y(12 * P), cx + 4 * P * px, y(0)], fill=spec["palette"]["limb"])
        buf = io.BytesIO()
        im.save(buf, "PNG")
        metrics = character_checks.stage_sheet_metrics(buf.getvalue(), spec, layout)
        self.assertTrue(metrics["ok"], metrics.get("problems"))
        self.assertEqual(metrics["form"], "block")


def make_cast():
    ids = []
    for family in ("square", "round", "triangle"):
        meta = character_store.create(character_store.starter_block(family, name=f"{character_store.STARTERS_BLOCK[family]['name']} {len(character_store.list_all())}"), by="t")
        ids.append(meta["id"])
    return ids


def story_beat(cid, other=None, **more):
    return {"id": more.pop("id", "s1"), "kind": "story", "speaker": cid, "say": "Help! Somebody help me now!",
            "story": {"place": "cliff", "cast": [{"character": cid, "pose": "hang", "mood": "scared"}] + ([{"character": other, "x": .7, "y": .9}] if other else []),
                      "shots": [{"shot": "close", "on": 0, "shake": True}, {"shot": "wide", "on": 0, "at": {"word": 1}}]}, **more}


class Story(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ids = make_cast()
        cls.cast = [{"character": c, "version": 1} for c in cls.ids]

    def create(self, beats, **options):
        return video_store.create("Story", look="brutalist", owner="test", beats=beats, aspects=["9:16"], cast=self.cast, **options)

    def test_a_story_beat_validates_and_times_from_its_line_and_gap(self):
        p = self.create([story_beat(self.ids[0], self.ids[1], gap=.3), {"id": "hold", "kind": "story", "hold": 1.4,
                                                                          "story": {"place": "village", "cast": [], "shots": [{"shot": "wide"}]}}])
        b = p["beats"][0]
        self.assertAlmostEqual(b["seconds"], math.ceil((video_store.STORY_LEAD + video_store.estimate(b["say"]) + .3) * 30 - 1e-6) / 30, places=6)
        self.assertAlmostEqual(p["beats"][1]["seconds"], 1.4, places=6)
        self.assertEqual(b["flashback"], False)

    def test_story_errors_name_what_to_fix(self):
        rook, fenn = self.ids[:2]
        cases = [
            ({"aspects": ["16:9"]}, [story_beat(rook)], "aspects"),
            ({}, [story_beat(rook), {"id": "t", "kind": "title", "text": "x", "bars": 1}], "beats"),
            ({}, [{**story_beat(rook), "speaker": None}], r"\.speaker"),
            ({}, [{**story_beat(rook), "gap": 3}], r"\.gap"),
            ({}, [{**story_beat(rook), "story": {"place": "moon"}}], r"story\.place"),
            ({}, [{**story_beat(rook), "story": {"place": "cliff", "shots": [{"shot": "close"}, {"shot": "wide", "at": {"word": 9}}]}}], r"shots\[1\]\.at\.word"),
            ({}, [{**story_beat(rook), "story": {"place": "cliff", "shots": [{"shot": "close"}, {"shot": "wide"}]}}], r"shots\[1\]\.at"),
            ({}, [{**story_beat(rook), "story": {"place": "cliff", "cast": [{"character": rook, "pose": "dab"}]}}], r"cast\[0\]\.pose"),
            ({}, [{**story_beat(rook), "story": {"place": "cliff", "fx": [{"kind": "fall"}]}}], r"fx\[0\]\.on"),
            ({}, [{**story_beat(rook), "story": {"place": "cliff", "sfx": [{"kind": "airhorn"}]}}], r"sfx\[0\]\.kind"),
            ({}, [{"id": "h", "kind": "story", "hold": 1, "gap": .3, "story": {"place": "cliff"}}], r"\.say"),
            ({}, [{"id": "t", "kind": "title", "text": "x", "bars": 1, "flashback": True}], r"\.flashback"),
        ]
        for options, beats, field in cases:
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, field):
                    video_store.create("Story", look="brutalist", owner="test", beats=beats, cast=self.cast, **{"aspects": ["9:16"], **options})

    def test_only_block_characters_play_story_beats(self):
        flat = character_store.create(character_store.starter("round", name="Flat Pip"), by="t")["id"]
        with self.assertRaisesRegex(ValueError, "classic block characters"):
            video_store.create("Story", look="brutalist", owner="t", aspects=["9:16"], beats=[story_beat(flat)],
                               cast=[{"character": flat, "version": 1}])

    def test_each_speaker_speaks_in_its_own_voice_and_key(self):
        rook, fenn = self.ids[:2]
        p = self.create([story_beat(rook), {**story_beat(fenn, id="s2"), "say": "Rook? What happened?"}])
        v1, v2 = (video_store.beat_voice(p, b) for b in p["beats"])
        self.assertEqual(video_store.voice_key(v1), "af_heart@1.14+1.5")
        self.assertEqual(video_store.voice_key(v2), "am_echo@1.08+3")
        self.assertNotEqual(video_store.speech_key(video_store.voice_key(v1), "Hi"), video_store.speech_key(video_store.voice_key(v2), "Hi"))
        self.assertEqual(video_store.voice_key({"id": "af_heart", "speed": 1, "pitch": 0}), "af_heart", "a plain voice keeps its old key")

    def test_prepare_speaks_each_line_in_its_speakers_voice_pitched_and_trimmed(self):
        rook, fenn = self.ids[:2]
        p = self.create([story_beat(rook), {**story_beat(fenn, id="s2"), "say": "Rook? What happened?"}])
        calls = []

        def synth(text, voice, speed=1.0):
            calls.append((voice, speed))
            t = np.arange(int(24000 * .6)) / 24000
            tone = np.sin(2 * np.pi * 200 * t) * 9000
            return np.concatenate([np.zeros(4800), tone, np.zeros(4800)]).astype("<i2").tobytes()
        shifted = []
        real_shift = video_narration.pitch_shift
        with patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(synth)})), \
                patch.object(video_narration, "pitch_shift", side_effect=lambda s, st: shifted.append(st) or s), \
                patch.object(video_narration.video_align, "for_beat", return_value={"align": {"method": "none", "confidence": 0., "note": "no speech model"}}):
            done = video_narration.prepare(p["id"])
        self.assertIn(("af_heart", 1.14), calls)
        self.assertIn(("am_echo", 1.08), calls)
        self.assertEqual(sorted(set(shifted)), [1.5, 3.0])
        for b in done["beats"]:
            s = b["spoken"]
            self.assertLess(s["seconds"], len(video_store.clauses(b["say"])) * 1.0, "the silent edges are trimmed")
            self.assertEqual(len(s["words"]), len(video_store.clause_words(b["say"])), "word times by letters when whisper.cpp cannot align")
            self.assertEqual(s["align"]["method"], "letters")
            self.assertRegex(s["mouth"], r"^[XAEOMF]+$")
            self.assertAlmostEqual(b["seconds"], round((video_store.STORY_LEAD + s["seconds"] + b["gap"]) * 30 + .4999) / 30, delta=1 / 30)
        self.assertIs(video_narration.pitch_shift, real_shift)

    @unittest.skipUnless(FFMPEG, "FFmpeg is not on this machine")
    def test_the_pitch_shift_keeps_the_length_and_moves_the_pitch(self):
        rate = video_narration.RATE
        t = np.arange(rate) / rate
        tone = (np.sin(2 * np.pi * 300 * t) * 12000).astype("<i2")
        out = video_narration.pitch_shift(tone, 3.0)
        self.assertLess(abs(len(out) - len(tone)), rate * .03, "the tempo is brought back: the length holds")
        spectrum = np.abs(np.fft.rfft(out[2000:-2000].astype(np.float64)))
        peak = np.argmax(spectrum) * rate / (len(out) - 4000)
        self.assertAlmostEqual(peak, 300 * 2 ** (3 / 12), delta=6)
        self.assertIs(video_narration.pitch_shift(tone, 0), tone)

    def test_trim_cuts_silent_edges_and_moves_the_parts(self):
        samples = np.concatenate([np.zeros(12000), np.full(2400, 8000), np.zeros(12000)]).astype("<i2")
        out, parts = video_narration.trim(samples, [[0.0, 1.1, "Hi."]])
        self.assertLess(len(out), 2400 + 2 * int(video_narration.TRIM_PAD * 24000) + 2)
        self.assertEqual(parts[0][2], "Hi.")
        self.assertLessEqual(parts[0][1], len(out) / 24000 + 1e-6)

    def test_letter_words_share_each_part_by_letters(self):
        words = video_narration.letter_words("Hi there, friend!", [[0.0, 0.5, "Hi there,"], [0.6, 1.0, "friend!"]])
        self.assertEqual(len(words), 3)
        self.assertLess(words[0][1], words[1][1])
        self.assertAlmostEqual(words[2][0], .6)

    def test_the_story_mix_levels_effects_and_flashback_dip(self):
        rook, fenn = self.ids[:2]
        beats = [{**story_beat(rook), "story": {**story_beat(rook)["story"], "sfx": [{"kind": "boom", "at": {"word": 1}}, {"kind": "steps", "at": {"t": 0}}]}},
                 {**story_beat(fenn, id="s2"), "say": "Like you did.", "flashback": True}]
        p = self.create(beats, music={"mood": "calm", "volume": .7})
        rate = video_narration.RATE

        def speak(say, voice, synth=None, speed=1.):
            t = np.arange(int(rate * .9)) / rate
            return (np.sin(2 * np.pi * 220 * t) * 6000).astype("<i2"), [[0.0, .9, say]]
        with patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(lambda *a, **k: b"")})), \
                patch.object(video_narration, "speak", side_effect=speak), patch.object(video_narration, "pitch_shift", side_effect=lambda s, st: s), \
                patch.object(video_narration.video_align, "for_beat", return_value={"align": {"method": "none", "confidence": 0.}}):
            video_narration.prepare(p["id"])
        p = video_store.get(p["id"])
        report = {}
        mix = video_audio.synthesize(p, report)
        self.assertEqual(report["format"], "story-short")
        self.assertEqual(report["sfx"], ["boom", "steps"])
        self.assertAlmostEqual(report["bed_db"], video_audio.STORY_BED_DB, delta=.6)
        self.assertLess(float(np.max(np.abs(mix))), 1.0)
        # The dialogue's speaking level is at the median target (it is the loudest thing in its stretch).
        voice, _ = video_narration.track(p, video_audio.SR)
        self.assertEqual(video_audio.synthesize(p).shape, mix.shape, "the mix is deterministic in shape")
        np.testing.assert_array_equal(video_audio.synthesize(p), mix, "and in every sample")
        # The bed is dipped in the flashback: compare its level in the two beats' silent tails (after each line).
        sr, starts = video_audio.SR, video_audio._starts(p)
        quiet = lambda b, at: mix[int((at + video_store.STORY_LEAD + b["spoken"]["seconds"] + .05) * sr):int((at + video_store.beat_seconds(b, 120) - .05) * sr)]   # noqa: E731
        first = video_audio._rms_db(quiet(p["beats"][0], starts[0])[:, 0].astype(np.float64))
        second = video_audio._rms_db(quiet(p["beats"][1], starts[1])[:, 0].astype(np.float64))
        self.assertGreater(first - second, 3, "the bed dips in the flashback")
        self.assertEqual(ffmpeg_tools.audio_args(video_audio.STORY_LUFS)[5], "loudnorm=I=-14:TP=-2.5:LRA=11")
        self.assertEqual(ffmpeg_tools.audio_args(-16), ffmpeg_tools.AUDIO_ARGS)

    def test_every_effect_is_synthesized_in_code(self):
        rng = np.random.default_rng(3)
        for kind in style_packs.STORY_SFX:
            sound = video_audio.sfx(kind, rng)
            self.assertGreater(len(sound), 1000, kind)
            self.assertTrue(np.isfinite(sound).all(), kind)
        self.assertEqual(len(video_audio.piano(2.0)), 2 * video_audio.SR)

    def test_render_notes_name_a_long_shot_and_keep_story_captions_to_one_word(self):
        p = self.create([{**story_beat(self.ids[0]), "say": "Help me get out of here right now, please, somebody, anybody, come on!",
                          "story": {"place": "cliff", "cast": [], "shots": [{"shot": "close"}]}}])
        notes = video_checks.story_notes(p, [{"time": 1, "elements": [{"role": "caption", "story": True, "beat": "s1", "text": "HELP ME"}]}])
        self.assertTrue(any("holds one shot" in n for n in notes), notes)
        self.assertTrue(any("one word at a time" in n for n in notes), notes)

    def test_the_fall_orbit_may_hold_longer_and_a_slip_validates(self):
        """2.3.0 polish: an orbit keeps moving, so a single orbit shot may hold up to 4.5 s; slip is a story pose."""
        self.assertIn("slip", style_packs.STORY_POSES)
        say = "Hit like and subscribe, everybody!"
        fall = {**story_beat(self.ids[0]), "say": say, "gap": 1.5, "story": {"place": "cliff", "cast": [{"character": self.ids[0], "pose": "hang",
                "changes": [{"at": {"word": 1}, "pose": "slip"}]}], "shots": [{"shot": "orbit"}], "fx": [{"kind": "fall", "on": 0, "at": {"t": 0}}]}}
        p = self.create([fall])
        self.assertGreater(p["beats"][0]["seconds"], video_checks.STORY_SHOT_MAX + .3)
        self.assertLessEqual(p["beats"][0]["seconds"], video_checks.STORY_ORBIT_MAX + .3)
        self.assertEqual(video_checks.story_notes(p), [], "the orbit holds without a note")
        held = self.create([{**fall, "story": {**fall["story"], "shots": [{"shot": "close"}]}}])
        self.assertTrue(any("holds one shot" in n for n in video_checks.story_notes(held)), "a still close of the same length is still named")


class PackAndFormat(unittest.TestCase):
    def test_block_classic_is_built_in_and_its_starter_is_generic(self):
        pack = style_packs.BUILT_IN["block-classic"]
        self.assertTrue(pack["available"])
        self.assertEqual(pack["formats"], ["story-short"])
        meta = style_pack_store.install_starter(style_pack_store.STARTER_CLASSIC_ID, by="t")
        data = style_pack_store.spec(meta["id"], 1)
        self.assertEqual(data["base"], "block-classic")
        self.assertEqual([character_store.spec(e["character"], e["version"])["form"] for e in data["characters"]], ["block"] * 3)
        self.assertEqual(style_pack_store.check_characters(data), [])
        text = json.dumps(style_pack_store.STARTER_CLASSIC).lower()
        for word in ("minecraft", "mojang", "creeper", "steve", "maizen", "mikey"):
            self.assertNotIn(word, text)
        # Its sample: a Story Short of three places, two flashbacks, 13 or more lines and every line's speaker in the cast.
        beats = style_pack_sample.beats(data)
        self.assertEqual(style_pack_sample.aspect_of(data), "9:16")
        self.assertGreaterEqual(sum(1 for b in beats if b.get("say")), 13)
        self.assertGreaterEqual(len({b["story"]["place"] for b in beats}), 3)
        self.assertEqual(sum(1 for i, b in enumerate(beats) if b.get("flashback") and not (i and beats[i - 1].get("flashback"))), 2)
        self.assertGreaterEqual(sum(len(b["story"]["shots"]) for b in beats), 18)
        # 2.3.0 polish: the slip loses a hand on the third "no" under the high angle; the fall holds 1.5 s after its line.
        by_id = {b["id"]: b for b in beats}
        self.assertEqual(by_id["slip"]["story"]["cast"][0]["changes"], [{"at": {"word": 2}, "pose": "slip"}])
        self.assertEqual([s["shot"] for s in by_id["slip"]["story"]["shots"]], ["close", "top"])
        self.assertEqual((by_id["fall"]["gap"], by_id["fall"]["story"]["shots"][0]["shot"]), (1.5, "orbit"))
        project = video_store.create(style_pack_sample.TITLE_STORY, owner="t", beats=beats, **style_pack_sample.project_options(data, meta["id"], 1))
        self.assertTrue(20 <= video_store.duration(project) <= 48, video_store.duration(project))
        self.assertEqual(style_pack_store.rule_notes(project, data), [])
        from services.content_studio import policy
        self.assertEqual(policy.hook_findings(project["title"], " ".join(b["say"] for b in project["beats"])), [], "no distress or rescue hook")
        with self.assertRaisesRegex(ValueError, "three.js only"):
            video_store.create("V", look="nordic", owner="t", renderer="blender",
                               beats=[{"id": "v", "kind": "voxel", "bars": 1, "voxel": {"world": "meadow", "look": "classic"}}])

    def test_a_classic_voxel_beat_casts_block_characters(self):
        rook = make_cast()[0]
        p = video_store.create("V", look="nordic", owner="t", cast=[{"character": rook, "version": 1}],
                               beats=[{"id": "v", "kind": "voxel", "bars": 1, "voxel": {"world": "meadow", "look": "classic", "cast": [{"character": rook}]}}])
        self.assertEqual(p["beats"][0]["voxel"]["look"], "classic")
        with self.assertRaisesRegex(ValueError, "blocky characters"):
            video_store.create("V", look="nordic", owner="t", cast=[{"character": rook, "version": 1}],
                               beats=[{"id": "v", "kind": "voxel", "bars": 1, "voxel": {"world": "meadow", "cast": [{"character": rook}]}}])
        plain = video_store.create("V", look="nordic", owner="t", beats=[{"id": "v", "kind": "voxel", "bars": 1, "voxel": {"world": "meadow", "look": "pastel"}}])
        self.assertNotIn("look", plain["beats"][0]["voxel"], "the pastel default is not stored")

    def test_the_shipped_story_short_card_is_added_once_and_stays_retired(self):
        from services.content_studio import formats, studio
        added = studio.ensure_shipped_formats()
        self.assertEqual(len(added), 1)
        self.assertEqual(studio.ensure_shipped_formats(), [])
        card = next(c for c in studio.list_formats("active") if c["name"] == "Story Short")
        self.assertEqual(card["evidence"], [])
        self.assertEqual(card["created_by"], formats.SHIPPED_BY)
        self.assertIn("Maizen", card["do_not_use"])
        self.assertGreaterEqual(len(card["beats"]), 8)
        studio.retire_format(card["id"], "test")
        self.assertEqual(studio.ensure_shipped_formats(), [], "a retired shipped card is not brought back")
        with self.assertRaises(Exception):
            formats.clean_format({**formats.SHIPPED["story-short"]})      # a researcher's card still needs evidence

    def test_the_brand_rule_covers_block_classic_and_the_named_channel(self):
        from services.content_studio import policy
        self.assertIn("block-classic", policy.VOXEL_BASES)
        self.assertTrue(policy.is_voxel("block-classic"))
        for fields in ({"title": "Minecraft story: he fell"}, {"tags": "mojang"}, {"title": "Creeper blows up the house"},
                       {"caption": "Like Maizen but better"}, {"thumbnail": "JJ and Mikey on a cliff"}):
            self.assertTrue(policy.brand_findings(fields), fields)
        self.assertEqual(policy.brand_findings({"title": "Rook hangs on", "tags": "block story, cliff, flashback"}), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
