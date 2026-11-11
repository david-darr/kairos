"""Pack C, the blocky voxel world (Video Styles build spec, section 3 Pack C; unit 6): what the backend holds and checks.

- voxel world determinism: the JavaScript model (scripts/test_voxel_model.mjs, run here too when Node is present) builds
  the same world from the same seed every time, inside its block budget, with the stage flat;
- the character spec and sheet: `form: voxel`, Kairos's blocky starters (Pip Block, Bo Block, Tilly Block) with our own
  proportions, the 3D sheet layout and page, the sheet checks on a synthetic sheet, and the Python body plan equal to
  static/motion/voxel.js voxelPlan;
- voxel beats: validated with plain messages, blocky characters only on voxel beats; the narration gives them mouth
  shapes from the line's own audio envelope (unit 3's method), as it now does for Pack B's stage beats;
- the pack: voxel-3d available on three.js only (no Blender), the starter "Blocky world explainer" with a generic name
  and no other game's name, its sample inside its own rules, 20 to 30 seconds of lines, and its cost check;
- the Evaluator's brand rule: the block game's or its maker's name is refused in a Pack C post's title, tags, caption
  and thumbnail, and in a Pack C port; other packs are not touched by it;
- made for kids: the channel's and the post's answer, Prepare post's checklist and fill plan, YouTube's
  selfDeclaredMadeForKids, and a Pack C post with no answer cannot be prepared or posted.

No render worker runs here: video-render-smoke --pack-c renders the real sample.
"""
import io
import json
import os
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

_DATA = TemporaryDirectory(prefix="kairos-pack-c-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name

from PIL import Image, ImageDraw  # noqa: E402

from core import (character_checks, character_sheet, character_store, style_pack_sample, style_pack_store, style_packs,  # noqa: E402
                  video_blender, video_narration, video_store)


def _let_go():
    try:
        from services.content_studio import close_all
        close_all()
    except Exception:
        pass


import atexit  # noqa: E402
atexit.register(_let_go)
NODE = shutil.which("node")


def node_eval(code):
    return json.loads(subprocess.run([NODE, "--input-type=module", "-e", code], capture_output=True, text=True, check=True, cwd=ROOT).stdout)


def sheet_image(spec, layout, *, body=None, head=None):
    """A synthetic blocky sheet drawn from the spec's plan: boxes where the real one draws them."""
    im = Image.new("RGB", (layout["w"], layout["h"]), layout["background"])
    d = ImageDraw.Draw(im)
    plan = character_checks.voxel_plan(spec)
    P = spec["proportions"]
    for cell in (layout["key"], next(c for c in layout["views"] if c["view"] == "front")):
        px = cell["height"] / character_checks.STAGE_HEIGHT
        cx, feet = cell["x"] + cell["w"] / 2, cell["feet"]
        y = lambda z: feet - z * px   # noqa: E731
        head_h = P["head"] * 1.5
        leg = max(.16, P["limb_length"] * 1.5 * .55)
        br = plan["br"] * px
        d.rectangle([cx - br, y(1.5 - head_h), cx + br, y(leg)], fill=body or spec["palette"]["body"])
        d.rectangle([cx - .36 * px, y(1.5), cx + .36 * px, y(1.5 - head_h)], fill=head or spec["palette"]["head"])
        d.rectangle([cx - br - .12 * px, y(1.5 - head_h - .02), cx - br - 2, y(leg + .1)], fill=spec["palette"]["limb"])
        d.rectangle([cx + br + 2, y(1.5 - head_h - .02), cx + br + .12 * px, y(leg + .1)], fill=spec["palette"]["limb"])
        d.rectangle([cx - .2 * px, y(leg), cx + .2 * px, y(0)], fill=spec["palette"]["limb"])
        d.rectangle([cx - 4, y(plan["top"]), cx + 4, y(1.5)], fill=spec["palette"]["accent"])
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


class World(unittest.TestCase):
    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_the_voxel_model_suite_passes(self):
        out = subprocess.run([NODE, str(ROOT / "scripts" / "test_voxel_model.mjs")], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("checks passed", out.stdout)

    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_the_same_seed_builds_the_same_world_in_two_separate_runs(self):
        code = ("import { worldModel, normalizeVoxel, WORLDS } from './static/motion/voxel.js';"
                "import { createHash } from 'node:crypto';"
                "console.log(JSON.stringify(WORLDS.map(w => createHash('sha256').update(JSON.stringify(worldModel(normalizeVoxel({ world: w, seed: 11 })))).digest('hex'))));")
        self.assertEqual(node_eval(code), node_eval(code))


class Characters(unittest.TestCase):
    def test_blocky_starters_are_their_own_form_with_our_own_colours(self):
        pip = character_store.starter_voxel("round")
        self.assertEqual((pip["name"], pip["form"]), ("Pip Block", "voxel"))
        self.assertEqual(character_store.form_of(pip), "voxel")
        bo = character_store.starter_voxel("square")
        self.assertNotEqual(bo["palette"]["limb"], character_store.STARTERS["square"]["palette"]["limb"])   # no teal-over-dark-blue
        self.assertEqual(character_store.starter_for("voxel", "triangle")["name"], "Tilly Block")
        with self.assertRaises(ValueError):
            character_store.validate({**pip, "form": "lego"})

    def test_the_blocky_sheet_uses_the_3d_layout_and_page_and_passes_its_checks(self):
        cid = character_store.create(character_store.starter_voxel("round", name="Pip Sheet"), by="test")["id"]
        html = character_sheet.page(cid, 1)
        self.assertIn("sheet3d.js", html)
        self.assertIn('"form": "voxel"', html)
        spec = character_store.spec(cid, 1)
        self.assertIs(character_sheet.layout_for(spec), character_sheet.LAYOUT_3D)
        metrics = character_checks.stage_sheet_metrics(sheet_image(spec, character_sheet.LAYOUT_3D), spec, character_sheet.LAYOUT_3D)
        self.assertTrue(metrics["ok"], metrics["problems"])
        self.assertEqual(metrics["form"], "voxel")
        wrong = character_checks.stage_sheet_metrics(sheet_image(spec, character_sheet.LAYOUT_3D, body="#22aa44", head="#2255dd"), spec,
                                                     character_sheet.LAYOUT_3D)
        self.assertFalse(wrong["ok"])

    @unittest.skipUnless(NODE, "Node is not on this machine")
    def test_the_python_body_plan_matches_voxel_js(self):
        for family in character_store.FAMILIES:
            for accessory in ("leaf", "antenna", "none"):
                spec = character_store.starter_voxel(family, accessory=accessory)
                plan = node_eval(f"import {{ voxelPlan, voxelCharacter }} from './static/motion/voxel.js';"
                                 f"const s = {json.dumps(spec)}, p = voxelPlan(s), c = voxelCharacter(s);"
                                 "const body = c.parts.find(x => x.name === 'body');"
                                 "const width = body.size[0] * (1 + (p.taper - 1) * ((p.zb - (body.pos[2] - body.size[2] / 2)) / body.size[2]));"
                                 "console.log(JSON.stringify({ zh: p.zh, zb: p.zb, face: p.forehead, top: c.top, br: width / 2 }));")
                mine = character_checks.voxel_plan(spec)
                for key in ("zh", "zb", "face", "top"):
                    self.assertAlmostEqual(plan[key], mine[key], places=6, msg=f"{family} {accessory} {key}")
                self.assertAlmostEqual(plan["br"], mine["br"], places=3, msg=f"{family} body width")

    def test_the_head_is_big_not_a_quarter_of_the_height(self):
        for family in character_store.FAMILIES:
            spec = character_store.starter_voxel(family)
            self.assertGreater(spec["proportions"]["head"], .36)


class Beats(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pip = character_store.create(character_store.starter_voxel("round", name="Pip Beats"), by="test")["id"]
        cls.pip3d = character_store.create(character_store.starter_3d("round", name="Pip Three"), by="test")["id"]

    def voxel(self, **more):
        return {"id": "v1", "kind": "voxel", "say": "Why is the sea salty?",
                "voxel": {"world": "ocean", "time": "night", "shot": "wide", "cast": [{"character": self.pip, "speaking": True}],
                          "people": {"count": 2}, "labels": [{"over": "c0", "text": "3.5%"}], **more}}

    def project(self, beats, **more):
        return {"id": "0123456789ab", "title": "t", "look": "nordic", "beats": beats,
                "cast": [{"character": self.pip, "version": 1}, {"character": self.pip3d, "version": 1}], **more}

    def test_a_voxel_beat_validates_and_names_what_to_fix(self):
        p = video_store.validate(self.project([self.voxel()]))
        v = p["beats"][0]["voxel"]
        self.assertEqual((v["seed"], v["cast"][0]["facing"], v["props"], v["labels"][0]["at"]), (0, "camera", [], 0))
        for bad, field in ((self.voxel(world="desert"), ".world"), (self.voxel(time="noon"), ".time"),
                           (self.voxel(props=[{"kind": "chest"}]), "props[0].kind"), (self.voxel(people={"count": 7}), "people.count"),
                           (self.voxel(seed=1000), ".seed"), (self.voxel(texture="grass"), ".texture"),
                           (self.voxel(labels=[{"over": "p2", "text": "x"}]), "labels[0].over")):
            with self.assertRaises(ValueError) as caught:
                video_store.validate(self.project([bad]))
            self.assertIn(field, str(caught.exception))

    def test_blocky_characters_play_voxel_beats_only(self):
        with self.assertRaises(ValueError) as caught:
            video_store.validate(self.project([self.voxel(cast=[{"character": self.pip3d}])]))
        self.assertIn("blocky characters", str(caught.exception))
        stage = {"id": "s", "kind": "stage", "bars": 1, "stage": {"cast": [{"character": self.pip}]}}
        with self.assertRaises(ValueError) as caught:
            video_store.validate(self.project([stage]))
        self.assertIn("3D characters", str(caught.exception))

    def test_a_voxel_video_renders_with_three_js(self):
        p = video_store.validate(self.project([self.voxel()]))
        self.assertEqual(video_blender.effective(p), "threejs")
        with self.assertRaises(ValueError) as caught:
            video_store.validate(self.project([self.voxel()], renderer="blender"))
        self.assertIn("three.js only", str(caught.exception))

    def test_mouth_shapes_come_from_the_lines_own_audio_for_voxel_and_stage_beats(self):
        self.assertEqual(video_narration.TALKING, ("scene", "stage", "voxel", "story"))
        project = video_store.create("Mouths", look="nordic", owner="test", beats=[self.voxel()], cast=[{"character": self.pip, "version": 1}],
                                     narration={"voice": "af_heart", "captions": True})
        rate = video_narration.RATE
        import numpy as np
        t = np.arange(int(rate * 1.2)) / rate
        tone = (np.sin(2 * np.pi * 220 * t) * 9000 * (np.sin(2 * np.pi * 3 * t) > 0)).astype(np.int16)
        with patch.object(video_narration, "_ready", return_value=type("K", (), {"synthesize": staticmethod(lambda *a, **k: None)})), \
                patch.object(video_narration, "speak", return_value=(tone, [[0.0, 1.2, "Why is the sea salty?"]])):
            done = video_narration.prepare(project["id"])
        mouth = done["beats"][0]["spoken"]["mouth"]
        self.assertRegex(mouth, r"^[XAEOMF]+$")
        self.assertTrue(set(mouth) - {"X"}, "the mouth opens while the line plays")
        self.assertIn("X", mouth, "and rests in the silences")


class Pack(unittest.TestCase):
    def test_voxel_3d_runs_on_three_js_only(self):
        pack = style_packs.BUILT_IN["voxel-3d"]
        self.assertTrue(pack["available"])
        self.assertEqual(pack["renderers"], ["threejs"])
        with self.assertRaises(ValueError):
            style_pack_store.validate({"name": "Blocks in Blender", "renderer": "blender", "base": "voxel-3d"})
        spec = style_pack_store.validate({"name": "Blocks", "renderer": "threejs", "base": "voxel-3d"})
        self.assertEqual(spec["scenes"]["times"], ["day", "dusk", "night"])
        with self.assertRaises(ValueError):
            style_pack_store.validate({"name": "Flat", "base": "flat-2d", "scenes": {"times": ["day"]}})

    def test_the_starter_is_generic_names_no_game_and_its_sample_keeps_its_rules(self):
        spec = style_pack_store.validate(style_pack_store.STARTER_VOXEL)
        self.assertEqual((spec["name"], spec["renderer"], spec["base"]), ("Blocky world explainer", "threejs", "voxel-3d"))
        text = json.dumps(style_pack_store.STARTER_VOXEL).lower()
        for word in ("minecraft", "mojang", "creeper", "steve", "grass block"):
            self.assertNotIn(word, text)
        self.assertNotIn("—", text)
        self.assertIn("made for kids", spec["director_brief"])
        pip = character_store.create(character_store.starter_voxel("round", name="Pip Starter"), by="test")["id"]
        data = {**spec, "characters": [{"character": pip, "version": 1}]}
        beats = style_pack_sample.beats(data)
        self.assertEqual({b["kind"] for b in beats}, {"voxel", "end"})
        self.assertEqual({b["voxel"]["world"] for b in beats if b["kind"] == "voxel"}, set(style_packs.VOXEL_WORLDS))
        self.assertEqual({b["voxel"]["time"] for b in beats if b["kind"] == "voxel"}, set(style_packs.VOXEL_TIMES))
        project = video_store.validate({"id": "0123456789ab", "title": style_pack_sample.TITLE_VOXEL, "look": "nordic", "beats": beats,
                                        **{k: v for k, v in style_pack_sample.project_options(data, "aaaaaaaaaaaa", 1).items() if k != "style_pack"}})
        self.assertEqual(style_pack_store.rule_notes(project, data), [b for b in style_pack_store.rule_notes(project, data) if "lasts" in b or "opening" in b])
        words = sum(len(b["say"].split()) for b in beats if "say" in b)
        self.assertTrue(45 <= words <= 75, f"{words} words: about 20 to 30 seconds at Kokoro's pace")

    def test_a_voxel_pack_casts_only_blocky_characters_and_gets_them_by_default(self):
        flat = character_store.create(character_store.starter("round", name="Flat Pip C"), by="test")["id"]
        spec = style_pack_store.validate({"name": "B", "renderer": "threejs", "base": "voxel-3d", "characters": [{"character": flat, "version": 1}]})
        self.assertTrue(any("blocky" in p for p in style_pack_store.check_characters(spec)))
        cast = style_pack_store.default_cast(style_pack_store.validate({"name": "D", "renderer": "threejs", "base": "voxel-3d",
                                                                         "look": {"families": ["square"]}}))
        self.assertEqual(character_store.form_of(character_store.spec(cast["characters"][0]["character"], 1)), "voxel")

    def test_the_cost_check_uses_pack_cs_own_speed_once_measured(self):
        from services.content_studio import formats
        cost = formats.cost("voxel-3d", 300)
        self.assertTrue(cost["available"])
        self.assertEqual(style_packs.BUILT_IN["voxel-3d"]["speed_key"], "threejs-voxel")
        if style_packs.RENDER_SPEED["threejs-voxel"]["measured"] != "not measured yet":
            self.assertIn("measured", cost["estimate"])
            self.assertEqual(cost["render_minutes"], round(style_packs.render_seconds_per_minute("threejs-voxel") * 5 / 60, 1))


class Studio(unittest.TestCase):
    """The Evaluator's brand rule and the made-for-kids answer, on the Content Studio store."""

    def setUp(self):
        from services.content_studio import studio
        self.studio = studio
        for table in ("preparations", "post_evidence", "posts", "channels", "niches"):
            studio._write(f"DELETE FROM {table}")
        self.niche = studio.create_niche("Nature questions")
        self.channel = studio.create_channel(self.niche["id"], "youtube", "@blocky.kairos")

    def post(self, pack="voxel-3d", title="Why is the sea salty?", **fields):
        post = self.studio.create_post(self.channel["id"], title, script_ref="Rain wears salt out of rocks.", style_pack=pack)
        if fields:
            self.studio.edit_post(post["id"], **fields)
        return self.studio.get_post(post["id"])

    def test_the_block_games_name_is_refused_in_a_pack_c_post(self):
        from services.content_studio import policy
        for fields in ({"title": "Minecraft facts: why the sea is salty"}, {"tags": "blocks, mine-craft, science"},
                       {"thumbnail": "MINECRAFT world at night"}, {"caption": "Like #minecraftmemes but science"},
                       {"title": "Why creepers would hate the sea"}, {"tags": "mojang"}):
            post = self.post(**{"title": "Sea", **fields})
            result = policy.check(self.studio, post["id"])
            self.assertFalse(result["ok"], fields)
            self.assertTrue(any(f["check"] == "brand" for f in result["findings"]), fields)
        clean = policy.check(self.studio, self.post(tags="ocean, salt, science")["id"])
        self.assertFalse(any(f["check"] == "brand" for f in clean["findings"]))
        self.assertFalse(policy.brand_findings({"title": "We examine crafts from the sea"}))
        other = policy.check(self.studio, self.post(pack="motion-type", title="Minecraft history explained")["id"])
        self.assertFalse(any(f["check"] == "brand" for f in other["findings"]), "only Pack C posts carry the rule")

    def test_a_pack_c_port_is_checked_for_the_name_too(self):
        from services.content_studio import policy
        found = policy.brand_findings({"example title": "Minecraft but real", "thumbnail": "", "mascot": "Pip Block"})
        self.assertEqual([f["field"] for f in found], ["example title"])

    def test_made_for_kids_comes_from_the_post_then_the_channel_and_pack_c_must_answer(self):
        from services.content_studio import StudioError, youtube_publish
        post = self.post()
        self.assertEqual(self.studio.audience(post), {"made_for_kids": None, "source": "unset"})
        self.assertEqual(self.studio.audience(self.post(pack="motion-type")), {"made_for_kids": False, "source": "default"})
        self.studio.edit_channel(self.channel["id"], made_for_kids="yes")
        self.assertEqual(self.studio.audience(self.studio.get_post(post["id"])), {"made_for_kids": True, "source": "channel"})
        self.studio.edit_post(post["id"], made_for_kids="no")
        self.assertEqual(self.studio.audience(self.studio.get_post(post["id"])), {"made_for_kids": False, "source": "post"})
        self.studio.edit_post(post["id"], made_for_kids="")
        self.assertEqual(self.studio.audience(self.studio.get_post(post["id"]))["source"], "channel")
        with self.assertRaises(StudioError):
            self.studio.edit_channel(self.channel["id"], made_for_kids="maybe")
        meta = youtube_publish.metadata(self.studio.get_post(post["id"]), "private", None, True)
        self.assertIs(meta["status"]["selfDeclaredMadeForKids"], True)
        self.assertIs(youtube_publish.metadata(post, "private")["status"]["selfDeclaredMadeForKids"], False)

    def test_prepare_and_youtube_posting_stop_a_pack_c_post_with_no_answer(self):
        from services.content_studio import prepare, youtube_publish
        renders = video_store._folder("aaaaaaaaaaaa") / "renders"
        renders.mkdir(parents=True, exist_ok=True)
        (renders / "16-9-v1.mp4").write_bytes(b"stand-in video")
        Image.new("RGB", (1920, 1080), (40, 90, 200)).save(renders / "thumb-16-9.png")
        self.studio.edit_channel(self.channel["id"], aspect="16:9")
        post = self.post(render_ref="/api/videos/aaaaaaaaaaaa/renders/16-9-v1.mp4", render_status="ok")
        self.studio._update("posts", post["id"], state="awaiting_approval")
        self.studio.approve(post["id"], "david")
        probe = lambda path: {"seconds": 26.0, "width": 1920, "height": 1080}   # noqa: E731
        package = prepare.assemble(self.studio, post["id"], probe_fn=probe)
        self.assertTrue(any("made for kids" in p for p in package["problems"]))
        self.assertIn("made for kids", youtube_publish.check(self.studio, post["id"]))
        self.studio.edit_channel(self.channel["id"], made_for_kids="yes")
        package = prepare.assemble(self.studio, post["id"], probe_fn=probe)
        self.assertFalse(package["problems"], package["problems"])
        audience = next(i for i in package["checklist"] if i["key"] == "made_for_kids")
        self.assertIn("Yes, it's made for kids", audience["text"])
        with patch.object(prepare, "probe", probe):
            prep = prepare.prepare(self.studio, post["id"], "david")
        plan = prepare.fill_plan(self.studio, prep["id"])
        self.assertEqual(next(t for t in plan["toggles"] if t["key"] == "made_for_kids")["value"], True)

    def test_the_fill_turns_on_the_answer_the_post_gives(self):
        js = (ROOT / "electron" / "studio-prepare.js").read_text(encoding="utf-8")
        self.assertIn('VIDEO_MADE_FOR_KIDS_MFK"]', js)
        self.assertIn("t.value === true ? table.made_for_kids_yes", js)


if __name__ == "__main__":
    unittest.main()
