"""User-made style packs (Video Styles build spec, section 3 "User-made style packs"): the pack format and its checks,
versions and the person-only approval, the starter pack, making a pack from a brief or a duplicate, channels picking a
pack, videos rendered only in an approved version, the sample, export and import (hostile files included), sharing
between accounts, captions kept clear of characters, and the bot tools that propose but never approve.

Two real accounts on a throwaway data folder, through the services and the real routes. No render worker runs here:
the sample's render is stood in for; video-render-smoke --style-pack renders the real one.
"""
import asyncio
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-style-packs-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import (accounts, character_store, style_pack_brief, style_pack_sample, style_pack_store as store,  # noqa: E402
                  style_packs, tool_registry, video_checks, video_render, video_store)
from core.auth import auth_manager  # noqa: E402
from routes import video_routes  # noqa: E402
from services import shared_library  # noqa: E402
from services.content_studio import StudioError, close_all, formats, studio  # noqa: E402
import atexit  # noqa: E402

def _let_go():
    """Close the studio stores, the rooms store and the app's log files, so the throwaway folder can be deleted on Windows."""
    import logging
    from core import bot_rooms_store
    close_all()
    bot_rooms_store.close()
    for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
        for handler in list(getattr(logger, "handlers", [])):
            if isinstance(handler, logging.FileHandler):
                handler.close()
                logger.removeHandler(handler)


atexit.register(_let_go)


def run(coro):
    return asyncio.run(coro)


def approve_characters(data):
    for entry in data["characters"]:
        meta = character_store.get(entry["character"])
        v = character_store.version_of(meta, entry["version"])
        if v["status"] == "approved":
            continue
        if v["status"] != "awaiting_approval":
            character_store.set_sheet(entry["character"], entry["version"], b"\x89PNG test sheet", {"ok": True})
        character_store.decide(entry["character"], entry["version"], True, "test")


def send_for_approval(pack_id, version=1):
    """What a finished sample does (core/style_pack_sample.make): the version now waits for the person."""
    approve_characters(store.spec(pack_id, version))
    return store.submit(pack_id, version, {"video_id": "000000000000", "seconds": 24.0, "notes": []})


def approved_pack(name="Calm explainer"):
    meta = store.duplicate(starter()["id"], name=name)
    send_for_approval(meta["id"])
    return store.decide(meta["id"], 1, True, "test")


_STARTER = {}


def starter():
    key = accounts.effective_account()
    if key not in _STARTER:
        _STARTER[key] = store.install_starter(by="test")
    return _STARTER[key]


class Accounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("david", "first-password-1", is_admin=True)
        auth_manager.create_user("bea", "second-password-2")
        cls.david, cls.bea = auth_manager.account_id("david"), auth_manager.account_id("bea")
        cls.clients = {}
        for name, password in (("david", "first-password-1"), ("bea", "second-password-2")):
            client = TestClient(kairos.app)
            r = client.post("/api/auth/login", json={"username": name, "password": password})
            assert r.status_code == 200, r.text
            cls.clients[name] = client

    def setUp(self):
        self._scope = accounts.as_account(self.david)
        self._scope.__enter__()

    def tearDown(self):
        self._scope.__exit__(None, None, None)


class PackFormat(Accounts):
    def test_the_starter_pack_is_complete_generic_and_kairos_own(self):
        data = store.validate(copy.deepcopy(store.STARTER))
        self.assertEqual((data["renderer"], data["base"]), ("2d-engine", "flat-2d"))
        self.assertEqual(data["look"]["families"], ["round", "square", "triangle"])
        self.assertIsInstance(data["look"]["palette"], dict)
        self.assertGreater(len(data["director_brief"]), 1500)
        text = json.dumps(store.STARTER).lower()
        for word in ("kurz", "gesagt", "bird", r"\bducks?\b", "in a nutshell"):
            self.assertNotRegex(text, word, "a shipped pack never names or copies a real channel")
        self.assertNotIn("—", text, "plain copy, no em-dashes")
        meta = starter()
        spec = store.spec(meta["id"], 1)
        names = sorted(character_store.get(e["character"])["name"] for e in spec["characters"])
        self.assertEqual(names, ["Bo", "Pip", "Tilly"])
        self.assertEqual(meta["origin"]["kind"], "starter")
        self.assertEqual(meta["origin"]["brief"], store.STARTER_BRIEF, "the brief stays attached")
        with self.assertRaises(store.ApprovalError):
            store.install_starter()

    def test_the_starter_palette_keeps_layers_apart_from_character_outlines(self):
        # Sheet-match checks walk down from a body's centre to its outline: a background layer close to an outline colour
        # would read as a thick outline. Every layer stays more than the checks' outline tolerance away.
        from core.character_checks import OUTLINE_TOL
        pal = store.STARTER["look"]["palette"]
        layers = pal["sky"] + [pal[k] for k in ("far", "mid", "near", "ground")]
        rgb = lambda h: [int(h[i:i + 2], 16) for i in (1, 3, 5)]   # noqa: E731
        for family in store.STARTER_CHARACTERS:
            outline = rgb(character_store.STARTERS[family]["palette"]["outline"])
            for layer in layers:
                distance = sum((a - b) ** 2 for a, b in zip(outline, rgb(layer))) ** .5
                self.assertGreater(distance, OUTLINE_TOL, (family, layer))

    def test_validation_names_the_field_to_fix(self):
        good = copy.deepcopy(store.STARTER)
        cases = [({"renderer": "unreal"}, "renderer"), ({"base": "glossy-3d"}, "base"), ({"cape": 1}, "pack.cape"),
                 ({"look": {"palette": "neon"}}, "look.palette"), ({"look": {"palette": {"sky": ["#000000"]}}}, "look.palette"),
                 ({"look": {"lighting": "hdr"}}, "look.lighting"), ({"look": {"outline": 40}}, "look.outline"),
                 ({"look": {"families": ["hexagon"]}}, "look.families"), ({"look": {"design_look": "../x"}}, "look.design_look"),
                 ({"scenes": {"settings": []}}, "scenes.settings"), ({"scenes": {"props": ["dragon"]}}, "scenes.props"),
                 ({"pacing": {"shot_seconds": [9, 2]}}, "pacing.shot_seconds"), ({"pacing": {"words_per_second": float("nan")}}, "pacing.words_per_second"),
                 ({"captions": {"case": "title"}}, "captions.case"), ({"music": {"mood": "epic"}}, "music.mood"),
                 ({"voice": {"voice": "Bad Voice"}}, "voice.voice"), ({"name": "<script>alert(1)</script>"}, "name"),
                 ({"name": "Bell\x07"}, "name"), ({"director_brief": "x" * 12001}, "director_brief"),
                 ({"base": "motion-type", "characters": [{"character": "a" * 12, "version": 1}]}, "characters")]
        for change, path in cases:
            with self.subTest(path=path):
                data = {**good, **change}
                if "look" in change:
                    data["look"] = {**good["look"], **change["look"]}
                with self.assertRaisesRegex(ValueError, "^" + path.replace(".", r"\.")):
                    store.validate(data)
        flat_rules = {k: v for k, v in good.items() if k != "scenes"}
        blender = store.validate({**flat_rules, "renderer": "blender", "base": "glossy-3d"})
        self.assertEqual(blender["base"], "glossy-3d", "3D renderers are recognised")
        self.assertEqual(blender["scenes"]["settings"][0], "lavender", "a 3D pack's rules name studio sets")
        with self.assertRaisesRegex(ValueError, "^scenes.settings"):
            store.validate({**good, "renderer": "blender", "base": "glossy-3d"})   # Pack A's meadow is not a 3D set

    def test_every_change_is_a_new_version_and_old_versions_never_change(self):
        meta = store.duplicate(starter()["id"], name="Versioned pack")
        pid = meta["id"]
        with self.assertRaisesRegex(ValueError, "nothing changed"):
            store.new_version(pid, {"music": {"mood": "calm"}})
        store.new_version(pid, {"director_brief": "A new brief.", "music": {"mood": "warm"}}, note="Warmer")
        self.assertEqual(store.spec(pid, 1)["music"]["mood"], "calm")
        self.assertEqual(store.spec(pid, 2)["music"]["mood"], "warm")
        self.assertEqual(store.spec(pid, 2)["director_brief"], "A new brief.")
        self.assertEqual([v["status"] for v in store.get(pid)["versions"]], ["draft", "draft"])
        self.assertEqual(store.duplicate(pid, name="Versioned pack")["name"], "Versioned pack 2", "names stay apart")


class Approval(Accounts):
    def test_only_a_sampled_version_with_approved_characters_can_be_approved(self):
        meta = store.duplicate(starter()["id"], name="Approval pack")
        pid = meta["id"]
        with self.assertRaises(store.ApprovalError):
            store.decide(pid, 1, True, "david")                       # no sample yet
        store.submit(pid, 1, {"video_id": "000000000000", "notes": []})
        data = store.spec(pid, 1)
        if any(not character_store.is_approved(e["character"], e["version"]) for e in data["characters"]):
            with self.assertRaisesRegex(store.ApprovalError, "character sheets"):
                store.decide(pid, 1, True, "david")
        approve_characters(data)
        store.decide(pid, 1, True, "david")
        self.assertTrue(store.is_approved(pid, 1))
        with self.assertRaises(store.ApprovalError):
            store.set_sample_status(pid, 1, "rendering")              # an approved version never changes
        with self.assertRaises(store.ApprovalError):
            store.decide(pid, 1, False, "david")

    def test_availability_follows_approval_and_the_renderer(self):
        draft = store.duplicate(starter()["id"], name="Unapproved pack")
        self.assertFalse(style_packs.get(draft["id"])["available"])
        done = approved_pack("Approved pack")
        entry = style_packs.get(done["id"])
        self.assertTrue(entry["available"])
        # Costed from its renderer's measured speed (the 2D engine, 1 unit a minute; Pack B unit 5).
        self.assertEqual((entry["base"], entry["units_per_minute"]), ("flat-2d", 1.0), "drawn and costed like its base")
        self.assertEqual(formats.cost(done["id"], 120)["units"], 2.0, "unit 2's cost check reads user packs from the registry")
        three = store.create({**store.validate({**copy.deepcopy(store.STARTER_3D), "renderer": "blender"}), "name": "Shiny 3D", "characters": []})
        self.assertFalse(style_packs.get(three["id"])["available"], "a 3D pack is available once approved, like any pack")
        voxel = store.create({k: v for k, v in store.validate(copy.deepcopy(store.STARTER)).items() if k != "scenes"} |
                             {"name": "Blocky", "renderer": "threejs", "base": "voxel-3d", "characters": []})
        self.assertFalse(style_packs.get(voxel["id"])["available"], "a blocky pack (Pack C) is available once approved, like any pack")
        self.assertEqual(style_packs.get(voxel["id"])["units_per_minute"], style_packs.BUILT_IN["voxel-3d"]["units_per_minute"])

    def test_no_tool_approves_and_the_approve_route_is_the_persons(self):
        names = [n for n in tool_registry._REGISTRY if "style_pack" in n]
        self.assertEqual(sorted(names), ["content_studio_propose_style_pack", "content_studio_style_pack_sample", "content_studio_style_packs"])
        self.assertFalse(any("approve" in n for n in names))
        from routes import style_pack_routes
        routes = {r.path for r in style_pack_routes.router.routes}
        self.assertIn("/api/style-packs/{pack_id}/versions/{version}/approve", routes)
        anonymous = TestClient(kairos.app)
        self.assertEqual(anonymous.post(f"/api/style-packs/{starter()['id']}/versions/1/approve").status_code, 401)


class Videos(Accounts):
    def make_video(self, pack, **changes):
        data = store.spec(pack["id"], 1)
        beats = style_pack_sample.beats(data)
        options = style_pack_sample.project_options(data, pack["id"], 1)
        options.update(changes)
        return video_store.create(style_pack_sample.TITLE, owner="david", beats=beats, **options)

    def test_a_video_renders_only_in_an_approved_version_except_the_packs_own_sample(self):
        pack = store.duplicate(starter()["id"], name="Gate pack")
        approve_characters(store.spec(pack["id"], 1))
        project = self.make_video(pack)
        self.assertEqual(project["style_pack"], {"id": pack["id"], "version": 1})
        self.assertTrue(video_render.pack_problems(project))
        self.assertEqual(video_render.pack_problems(project, sample_of=(pack["id"], 1)), [])
        self.assertTrue(video_render.pack_problems(project, sample_of=(pack["id"], 2)))
        with patch.object(video_render.ffmpeg_tools, "find", return_value="ffmpeg"), \
                patch.object(video_render.design_render_bridge, "available", return_value=True):
            with self.assertRaisesRegex(ValueError, "style_pack"):
                video_render.start(project["id"], "16:9")
        send_for_approval(pack["id"])
        store.decide(pack["id"], 1, True, "david")
        self.assertEqual(video_render.pack_problems(video_store.get(project["id"])), [])
        with self.assertRaisesRegex(ValueError, "style_pack"):
            video_store.validate({**project, "style_pack": {"id": "ffffffffffff", "version": 1}})
        with self.assertRaisesRegex(ValueError, "style_pack"):
            video_store.validate({**project, "style_pack": {"id": pack["id"], "version": 1, "sample": True}})

    def test_the_sample_follows_the_pack_rules_and_lasts_20_to_30_seconds_when_spoken(self):
        pack = approved_pack("Rules pack")
        data = store.spec(pack["id"], 1)
        project = self.make_video(pack)
        settings = {b["scene"]["setting"] for b in project["beats"] if b["kind"] == "scene"}
        self.assertTrue(settings <= set(data["scenes"]["settings"]))
        self.assertIn("close", {b["scene"]["shot"] for b in project["beats"] if b["kind"] == "scene"}, "covers the caption fix")
        self.assertEqual(project["narration"]["voice"], data["voice"]["voice"])
        words = sum(len(b["say"].split()) for b in project["beats"] if "say" in b)
        estimate = sum(video_store.LEAD + video_store.estimate(b["say"]) + video_store.TAIL if "say" in b
                       else video_store.beat_seconds(b, project["bpm"]) for b in project["beats"])
        self.assertTrue(55 <= words <= 75 and 18 <= estimate <= 32, (words, estimate))
        stray = copy.deepcopy(project)
        stray["beats"][1]["camera"] = "shake"
        stray["beats"][1]["scene"]["setting"] = "room"
        notes = store.rule_notes(stray, data)
        self.assertTrue(any("shake camera" in n for n in notes) and any("set in room" in n for n in notes), notes)
        motion = store.validate({**copy.deepcopy(store.STARTER), "base": "motion-type", "characters": [], "name": "Type only"})
        kinds = [b["kind"] for b in style_pack_sample.beats(motion)]
        self.assertNotIn("scene", kinds)

    def test_the_samples_cards_carry_no_scene_line_and_one_light_per_sky(self):
        # The 2026-11-10 sample captioned "Six months later, your half leans away." on its end card.
        pack = approved_pack("Cards pack")
        project = self.make_video(pack)
        motion = store.validate({**copy.deepcopy(store.STARTER), "base": "motion-type", "characters": [], "name": "Type cards"})
        for beats in (project["beats"], style_pack_sample.beats(motion)):
            self.assertEqual(beats[-1]["kind"], "end")
            self.assertNotIn("say", beats[-1], "the end card is silent")
            self.assertIn(style_pack_sample.LINES["winter"], [b.get("say") for b in beats], "the winter line has its own beat")
            self.assertEqual([b.get("say") for b in beats if "say" in b], list(style_pack_sample.LINES.values()))
            self.assertEqual(video_checks.card_narration_notes({**project, "beats": beats}), [])
        for b in project["beats"]:
            if b["kind"] == "scene":
                lights = [p["icon"] for p in b["scene"]["props"] if p["icon"] in ("sun", "moon")]
                self.assertLessEqual(len(lights), 1, f"{b['id']}: one light prop per scene (the sky draws none beside it)")

    def test_the_player_gets_the_packs_look_as_numbers_only(self):
        pack = approved_pack("Player pack")
        project = self.make_video(pack)
        page = video_routes.player_page(project)
        data = json.loads(page.split('id="kd-project">', 1)[1].split("</script>", 1)[0])
        self.assertEqual(set(data["pack"]), {"palette", "lighting", "caption_case"})
        self.assertEqual(data["pack"]["palette"], store.STARTER["look"]["palette"])
        self.assertNotIn("director_brief", page)

    def test_a_body_is_measured_through_its_belly_patch_for_every_starting_family(self):
        # Found with the starter pack: Tilly's belly patch (head colour at 55% over the body) matched neither colour, so
        # a triangle character's sheet could never pass its own checks.
        import numpy as np
        from core import character_checks
        for family in ("round", "square", "triangle"):
            pal = character_store.STARTERS[family]["palette"]
            rgb = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)   # noqa: E731
            column = np.zeros((60, 1, 3), dtype=np.float32) + 246
            column[:30] = rgb(pal["head"]) * .55 + rgb(pal["body"]) * .45
            column[30:33] = rgb(pal["outline"])
            row = character_checks._column_measure(column, pal, 0, 10)
            self.assertEqual((row or {}).get("outline_px"), 3.0, family)

    def test_captions_are_kept_clear_of_characters(self):
        caption = {"beat": "b", "kind": "text", "role": "caption", "x": 600, "y": 870, "w": 700, "h": 110, "text": "x"}
        over = {"beat": "b", "kind": "character", "shot": "close", "x": 700, "y": 400, "w": 400, "h": 600}
        clipped = {**over, "h": 470, "clip": 870}       # a close shot cut at the near ground
        touching = {**over, "h": 476}                   # a few pixels: an anti-aliased edge
        self.assertTrue(video_checks.caption_clear_notes([{"time": 1, "elements": [caption, over]}]))
        self.assertEqual(video_checks.caption_clear_notes([{"time": 1, "elements": [caption, clipped]}]), [])
        self.assertEqual(video_checks.caption_clear_notes([{"time": 1, "elements": [caption, touching]}]), [])
        project = {"beats": [{"id": "b", "kind": "statement", "bars": 2, "text": "Hi"}], "bpm": 120}
        self.assertTrue(any("caption covers a character" in n for n in
                            video_checks.check(project, "16:9", [{"time": 1, "elements": [caption, over]}])))


class Making(Accounts):
    def test_a_brief_becomes_a_pack_through_a_model_and_stays_attached(self):
        brief = "Calm explainers about the ocean. Deep teal water, warm sand, slow pans, gentle music, upper case captions."
        reply = json.dumps({"name": "Ocean calm", "base": "flat-2d", "summary": "Slow ocean explainers.",
                            "look": {"palette": "mint", "lighting": "soft", "families": ["round"]},
                            "scenes": {"settings": ["ocean", "meadow"], "cameras": ["still", "pan"]},
                            "captions": {"case": "upper"}, "characters": [{"character": "abcdefabcdef", "version": 1}],
                            "owner": "someone else"})
        ask = AsyncMock(return_value="Here it is:\n" + reply + "\nDone.")
        data = run(style_pack_brief.draft(brief, ask=ask))
        self.assertNotIn("owner", data, "only the pack's own fields are taken from a model")
        self.assertEqual(data["characters"], [], "a model cannot name this account's characters")
        self.assertEqual(data["director_brief"], brief)
        self.assertEqual(data["captions"]["case"], "upper")
        with_cast = store.default_cast(data, by="test")
        self.assertEqual(len(with_cast["characters"]), 1)
        self.assertEqual(character_store.get(with_cast["characters"][0]["character"])["family"], "round")
        with self.assertRaisesRegex(ValueError, "did not return pack data"):
            run(style_pack_brief.draft(brief, ask=AsyncMock(return_value="I cannot do that.")))

    def test_the_brief_route_uses_the_accounts_own_model_and_refuses_without_one(self):
        client = self.clients["david"]
        r = client.post("/api/style-packs", json={"source": "brief", "brief": "Bright pop science."})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("model connection", r.text)
        fake = AsyncMock(return_value=json.dumps({"name": "Pop science", "base": "motion-type", "music": {"mood": "energetic"}}))
        with patch.object(style_pack_brief, "ask_model", fake):
            r = client.post("/api/style-packs", json={"source": "brief", "brief": "Bright pop science."})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["origin"]["kind"], body["origin"]["brief"], body["spec"]["director_brief"]),
                         ("brief", "Bright pop science.", "Bright pop science."))

    def test_routes_list_duplicate_edit_and_export(self):
        client = self.clients["david"]
        pid = starter()["id"]
        listed = client.get("/api/style-packs").json()
        self.assertIn(pid, [p["id"] for p in listed["packs"]])
        self.assertEqual(listed["starters"][0]["name"], "Flat science explainer")
        copy_ = client.post("/api/style-packs", json={"source": "duplicate", "pack_id": pid, "name": "Route copy"}).json()
        r = client.post(f"/api/style-packs/{copy_['id']}/versions", json={"changes": {"director_brief": "Shorter brief."}, "note": "Edit"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["versions"][-1]["version"], 2)
        self.assertEqual(client.post(f"/api/style-packs/{copy_['id']}/versions/2/approve").status_code, 409)
        exported = client.get(f"/api/style-packs/{copy_['id']}/export?v=2")
        self.assertEqual(exported.status_code, 200)
        self.assertIn("attachment", exported.headers["content-disposition"])
        self.assertEqual(json.loads(exported.content)["pack"]["director_brief"], "Shorter brief.")

    def test_the_sample_waits_for_character_sheets_first(self):
        pack = store.duplicate(starter()["id"], name="Sheets first")
        data = store.spec(pack["id"], 1)
        sheets = AsyncMock(side_effect=lambda cid, v: character_store.set_sheet(cid, v, b"\x89PNG s", {"ok": True}))
        with patch.object(style_pack_sample.character_sheet, "submit", sheets):
            out = run(style_pack_sample.make(pack["id"], 1, owner="david"))
        if any(not character_store.is_approved(e["character"], e["version"]) for e in data["characters"]):
            self.assertEqual(out["step"], "sheets")
            self.assertTrue(store.version_of(out, 1)["sample"]["status"].startswith("waiting"))
        approve_characters(data)

        async def fake_render(video_id, aspect, sample_of=None):
            self.assertEqual(sample_of, (pack["id"], 1))
            folder = video_store._folder(video_id) / "renders"
            folder.mkdir(parents=True, exist_ok=True)
            for name in ("16-9-v1.mp4", "sheet-16-9.png", "thumb-16-9.png"):
                (folder / name).write_bytes(b"x")
            return {"status": "ready", "path": str(folder / "16-9-v1.mp4"), "seconds": 24.5, "notes": [], "loudness": {}}
        with patch.object(style_pack_sample.video_render, "render", fake_render):
            out = run(style_pack_sample.make(pack["id"], 1, owner="david"))
        self.assertEqual(out["step"], "sample")
        self.assertEqual(store.version_of(out, 1)["status"], "awaiting_approval")
        self.assertTrue(store.sample_path(pack["id"], 1).is_file())
        self.assertIn(pack["id"], [p["id"] for p in store.pending()])


class Channels(Accounts):
    def test_a_channel_picks_an_approved_pack_and_its_posts_use_it(self):
        niche = studio.create_niche("Pack niche")
        channel = studio.create_channel(niche["id"], "youtube", "@packs")
        draft = store.duplicate(starter()["id"], name="Channel draft")
        with self.assertRaisesRegex(StudioError, "cannot be used yet"):
            studio.edit_channel(channel["id"], style_pack=draft["id"])
        with self.assertRaisesRegex(StudioError, "not in this account"):
            studio.edit_channel(channel["id"], style_pack="ffffffffffff")
        pack = approved_pack("Channel pack")
        self.assertEqual(studio.edit_channel(channel["id"], style_pack=pack["id"])["style_pack"], pack["id"])
        post = studio.create_post(channel["id"], "A post in the pack")
        self.assertEqual(post["style_pack"], pack["id"])
        self.assertEqual(studio.create_post(channel["id"], "Typed", style_pack="motion-type")["style_pack"], "motion-type")
        self.assertIsNone(studio.edit_channel(channel["id"], style_pack="")["style_pack"])


def pack_file(**changes):
    data = json.loads(store.export_bytes(starter()["id"]))
    data.update(changes)
    return data


class ImportExport(Accounts):
    def test_export_carries_data_only(self):
        raw = store.export_bytes(starter()["id"])
        data = json.loads(raw)
        self.assertEqual(set(data), {"format", "format_version", "exported", "pack", "characters"})
        text = raw.decode("utf-8")
        for never in (self.david, "owner", "\"by\"", "\"sample\"", "awaiting", "video_id", starter()["id"]):
            self.assertNotIn(never, text)
        self.assertEqual(len(data["characters"]), 3)
        self.assertTrue(all(set(c) == {"ref", "spec"} for c in data["characters"]))

    def test_a_round_trip_lands_as_a_draft_and_reuses_identical_characters(self):
        raw = store.export_bytes(starter()["id"])
        before = len(character_store.list_all())
        meta = store.import_bytes(raw, by="david")
        self.assertEqual([v["status"] for v in meta["versions"]], ["draft"])
        self.assertEqual(len(character_store.list_all()), before)
        with accounts.as_account(self.bea):
            other = store.import_bytes(raw, by="bea")
            spec = store.spec(other["id"], 1)
            self.assertEqual(len(spec["characters"]), 3, "made in the importer's own account")
            self.assertTrue(all(character_store.get(e["character"]) for e in spec["characters"]))

    def test_hostile_files_are_refused(self):
        deep = {"a": 1}
        for _ in range(20):
            deep = {"a": deep}
        good = pack_file()
        characters = good["characters"]
        cases = {
            "too large": b"{" + b" " * (store.MAX_FILE_BYTES + 10) + b"}",
            "not json": b"MZ\x90\x00 an executable",
            "not utf-8": b"\xff\xfe\x00{",
            "empty": b"",
            "NaN": json.dumps(good).replace('"words_per_second": 2.6', '"words_per_second": NaN').encode(),
            "repeated key": json.dumps(good).replace('"format": "kairos.style-pack"', '"format": "kairos.style-pack", "format": "x"').encode(),
            "deep": json.dumps({**good, "pack": {**good["pack"], "look": deep}}).encode(),
            "unknown top field": json.dumps({**good, "script": "rm -rf /"}).encode(),
            "wrong format": json.dumps({**good, "format": "kairos.package"}).encode(),
            "newer version": json.dumps({**good, "format_version": 2}).encode(),
            "list at top": b"[1, 2, 3]",
            "secret in the brief": json.dumps({**good, "pack": {**good["pack"], "director_brief": "Use sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"}}).encode(),
            "unknown pack field": json.dumps({**good, "pack": {**good["pack"], "on_load": "fetch('https://x.test')"}}).encode(),
            "script in the name": json.dumps({**good, "pack": {**good["pack"], "name": "<img src=x onerror=alert(1)>"}}).encode(),
            "ids in the pack": json.dumps({**good, "pack": {**good["pack"], "characters": [{"character": "aaaaaaaaaaaa", "version": 1}]}}).encode(),
            "bad character": json.dumps({**good, "characters": [{"ref": "c1", "spec": {**characters[0]["spec"], "palette": {"body": "red"}}}]}).encode(),
            "path in a ref": json.dumps({**good, "characters": [{"ref": "../../c1", "spec": characters[0]["spec"]}]}).encode(),
            "too many characters": json.dumps({**good, "characters": [{"ref": f"c{i}", "spec": characters[0]["spec"]} for i in range(1, 9)]}).encode(),
            "extra character field": json.dumps({**good, "characters": [{**characters[0], "rig": "eval()"}]}).encode(),
            "motion type with characters": json.dumps({**good, "pack": {**good["pack"], "base": "motion-type"}}).encode(),
            "bad palette": json.dumps({**good, "pack": {**good["pack"], "look": {**good["pack"]["look"], "palette": {"sky": ["javascript:x", "#000000"]}}}}).encode(),
        }
        before = len(store.list_all())
        for label, raw in cases.items():
            with self.subTest(label), self.assertRaises(store.ImportRefused):
                store.import_bytes(raw, by="david")
        self.assertEqual(len(store.list_all()), before, "nothing refused was stored")
        bom = b"\xef\xbb\xbf" + json.dumps(good).encode()
        self.assertEqual(store.import_bytes(bom, by="david")["versions"][0]["status"], "draft")

    def test_the_import_route_checks_the_file(self):
        client = self.clients["david"]
        r = client.post("/api/style-packs/import", files={"file": ("pack.json", json.dumps(pack_file()).encode(), "application/json")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["origin"]["kind"], "import")
        r = client.post("/api/style-packs/import", content=b'{"format": "kairos.style-pack", "format_version": 1, "pack": 5}',
                        headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 422)
        r = client.post("/api/style-packs/import", content=b"x" * (store.MAX_FILE_BYTES + 100), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 422)


class Sharing(Accounts):
    def test_an_approved_pack_is_shared_and_added_as_a_draft_copy(self):
        draft = store.duplicate(starter()["id"], name="Not yet shared")
        with self.assertRaisesRegex(shared_library.LibraryError, "Approve"):
            shared_library.share("style_pack", draft["id"])
        pack = approved_pack("Shared pack")
        item = shared_library.share("style_pack", pack["id"], "A calm look")
        self.assertEqual(item["kind"], "style_pack")
        with accounts.as_account(self.bea):
            details = shared_library.details(item["id"])
            self.assertEqual(details["name"], "Shared pack")
            added = shared_library.add(item["id"])
            copy_ = store.get(added["local_id"])
            self.assertEqual(copy_["origin"]["kind"], "shared")
            self.assertEqual([v["status"] for v in copy_["versions"]], ["draft"], "the adder approves it in their own account")
        store.new_version(pack["id"], {"music": {"mood": "warm"}})
        send_for_approval(pack["id"], 2)
        store.decide(pack["id"], 2, True, "david")
        shared_library.share("style_pack", pack["id"])
        with accounts.as_account(self.bea):
            shared_library.update(item["id"])
            self.assertEqual(store.spec(added["local_id"], 2)["music"]["mood"], "warm", "an update is a new draft version")

    def test_accounts_never_see_each_others_packs(self):
        pack = approved_pack("Private pack")
        bea = self.clients["bea"]
        self.assertNotIn(pack["id"], json.dumps(bea.get("/api/style-packs").json()))
        for path in (f"/api/style-packs/{pack['id']}", f"/api/style-packs/{pack['id']}/export",
                     f"/api/style-packs/{pack['id']}/versions/1"):
            self.assertEqual(bea.get(path).status_code, 404, path)
        self.assertEqual(bea.post(f"/api/style-packs/{pack['id']}/versions/1/reject", json={}).status_code, 404)
        self.assertEqual(bea.post("/api/style-packs", json={"source": "duplicate", "pack_id": pack["id"]}).status_code, 404)


class BotTools(Accounts):
    def call(self, tool, role, **args):
        from core.tool_registry import ToolContext
        spec = tool_registry._REGISTRY[tool]
        from services.agent_service import agent_service
        bot = {"id": "bot-x", "name": role.title()}
        with patch.object(agent_service, "get", return_value=bot), \
                patch("core.bot_content_studio_tools.team.role_of", return_value=role):
            return run(spec.handler(args, ToolContext(agent_id="bot-x")))

    def test_the_producer_and_editor_propose_and_never_approve(self):
        out = self.call("content_studio_propose_style_pack", "producer", brief="Bright city explainers with quick cuts.",
                        name="City quick", base="flat-2d", look={"palette": "dusk", "families": ["square"]},
                        scenes={"settings": ["city"], "transitions": ["cut", "whip"]})
        self.assertIn("is a draft", out)
        meta = next(m for m in store.list_all() if m["name"] == "City quick")
        spec = store.spec(meta["id"], 1)
        self.assertEqual((meta["origin"]["kind"], spec["director_brief"]), ("brief", "Bright city explainers with quick cuts."))
        self.assertEqual(len(spec["characters"]), 1, "a flat-2d pack gets its family's character")
        out = self.call("content_studio_propose_style_pack", "editor", pack_id=meta["id"], brief="Slower now.", note="Calmer")
        self.assertIn("Version 2 is a draft", out)
        out = self.call("content_studio_propose_style_pack", "researcher", brief="x")
        self.assertIn("Not run", out)
        out = self.call("content_studio_propose_style_pack", "producer", brief="x", name="<b>bad</b>")
        self.assertIn("Not run: name", out)
        listed = self.call("content_studio_style_packs", "evaluator")
        self.assertIn("City quick", listed)


if __name__ == "__main__":
    unittest.main()
