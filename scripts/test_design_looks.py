"""Bundled looks, creative direction and the shell-free design checks
(vault: "Creative Output Quality and Video Studio (Build Spec)", Phase 1).

What these prove, with no model, browser or Electron started:

- every bundled look validates: its text and accent pairs reach WCAG AA, its
  fonts exist on disk with their OFL licence, and THIRD_PARTY_NOTICES lists them;
- a look is a full design system: tokens, fonts served by alias (never a path
  outside the look's own files), components, a preview with no script, and a
  saved system can never take a look's id;
- creative_direction gives different looks to different subjects across the
  24 benchmark briefs, offers Kairos only when the brief is about Kairos, ranks
  a person's recently used looks lower, and reads the output type from the brief;
- design_create with no look creates nothing and returns three directions, on
  every surface, and a small-window local model sees creative_direction directly;
- the checks flag type under a format's floor, empty placeholder boxes and grey
  bars, and leave decoration and real content alone;
- Tool Store's default look is admin-only and new hand-made designs start in it.

Run: .venv\\Scripts\\python.exe scripts\\test_design_looks.py
"""
import asyncio
import io
import json
import os
import re
import shutil
import sys
import unittest
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = Path(__file__).resolve().parents[1] / (".looks-test-" + uuid.uuid4().hex[:12])
environment.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(environment)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import (creative_direction, design_checks, design_export, design_html, design_looks, design_render,  # noqa: E402
                  design_store, design_systems, settings as settings_store, tool_registry)
from core.external_brain import ExternalBrain  # noqa: E402
from core.middleware import SecurityHeadersMiddleware  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import design_routes  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
SUBJECTS = {
    "soccer": "PSA Soccer Camp, a kids' soccer camp, ages 8 to 10, first touch, passing and teamwork",
    "mocktrial": "our CS 405 mock trial, Moon Microsystems v. John Zucchini, a cybersquatting claim; we represent the defendant",
    "saas": "Ledgerly, an invoicing app launch for freelancers: invoices, reminders, card and bank payments",
    "minecraft": "our Minecraft server's comeback, 'Get back on the server', relaunch weekend, dragon fight",
}
TYPES = {"poster": "Make a poster for {s}.", "screen": "Design the home screen for {s}'s app.",
         "pdf": "Write a 3 to 6 page guide for {s} as a PDF.", "slides": "Make a 10-slide deck pitching {s}.",
         "social": "Make an Instagram post announcing {s}.", "video": "Make a 20-second vertical promo video for {s}."}


def run(coro):
    return asyncio.run(coro)


def ctx(session_id, surface=tool_registry.OPENAI):
    return tool_registry.ToolContext(session_id=session_id, is_admin=True, turn_taint=TurnTaint(), surface=surface)


def call(name, args, session_id, surface=tool_registry.OPENAI):
    result = run(tool_registry.call(name, args, ctx(session_id, surface), surface))
    return result.text if isinstance(result, tool_registry.ToolResult) else result


def new_chat(owner="local"):
    return session_manager.create_session("looks chat", owner_user=owner)["id"]


class LookBundleTests(unittest.TestCase):
    def test_every_look_validates_and_is_readable(self):
        looks = design_looks.load(refresh=True)
        self.assertGreaterEqual(len(looks), 23, "about 24 looks with Kairos")
        for look in looks.values():
            for fg, bg in design_looks.AA_PAIRS:
                ratio = design_looks._contrast(look["color"][fg], look["color"][bg])
                self.assertGreaterEqual(ratio, 4.5, f"{look['id']}: {fg} on {bg}")
        bad = dict(json.loads((REPO / "design_looks" / "sport" / "look.json").read_text(encoding="utf-8")))
        bad["color"] = {**bad["color"], "text-dim": "#30363D"}
        with self.assertRaisesRegex(ValueError, "under WCAG AA"):
            design_looks._validate("sport", bad)

    def test_fonts_ship_with_their_licence_and_notice(self):
        notices = (REPO / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        used = {k for look in design_looks.load().values() for k in look["fonts"].values()}
        for key in used:
            files = design_looks._face_files(key)
            self.assertTrue(files, key)
            for _, path, _, _ in files:
                self.assertTrue(path.is_file(), path)
            if key not in design_looks.APP_FONTS:
                self.assertTrue((design_looks.FONTS_DIR / key / "OFL.txt").is_file(), key)
                self.assertIn(f"- {key}: Copyright", notices, key)
        self.assertIn("2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc", notices, "the pinned google/fonts commit")

    def test_a_look_is_a_full_design_system(self):
        system = design_systems.get("editorial")
        self.assertTrue(system["bundled"])
        flat = design_systems.variables(system["tokens"])
        for name in ("--ds-bg", "--ds-text", "--ds-accent", "--ds-on-accent", "--ds-font-display", "--ds-font-sans",
                     "--ds-radius-m", "--ds-border-w", "--ds-size-7", "--ds-space-8"):
            self.assertIn(name, flat)
        self.assertIn('"Fraunces"', flat["--ds-font-display"])
        self.assertIn("--ds-font-display", design_systems.variables(design_systems.kairos_tokens()), "Kairos has one too")
        ids = [s["id"] for s in design_systems.list_systems()]
        self.assertEqual(ids[0], "kairos")
        self.assertIn("retro-pixel", ids)
        components = system["components"]
        for name in ("button.primary", "button.secondary", "card", "list.row", "nav.bar", "tab.bar", "input", "kicker", "headline"):
            self.assertIn(f'data-kd-component="{name}"', components)
        self.assertNotEqual(design_systems.get("sport")["components"], components, "each look its own components")
        with self.assertRaises(ValueError):
            design_systems.save("Clash", {"color": {"bg": "#000000"}}, system_id="editorial")

    def test_fonts_are_served_by_alias_only(self):
        faces = design_systems.font_faces("retro-pixel", "/api/design-fonts")
        self.assertIn('url("/api/design-fonts/retro-pixel/pressstart2p-0.ttf")', faces)
        self.assertIsNotNone(design_systems.font_path("retro-pixel", "pressstart2p-0.ttf"))
        self.assertIsNone(design_systems.font_path("retro-pixel", "fraunces-0.ttf"), "another look's font")
        for bad in ("../OFL.txt", "pressstart2p-0.ttf/../../x", "PressStart2P-Regular.ttf", "x-99.ttf"):
            self.assertIsNone(design_systems.font_path("retro-pixel", bad), bad)

    def test_preview_runs_no_script_and_keeps_its_policy(self):
        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)
        app.include_router(design_routes.render_router)
        client = TestClient(app)
        page = client.get("/api/design-looks/sport/preview")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn("<script", page.text)
        policy = page.headers["content-security-policy"]
        self.assertIn("script-src 'none'", policy)
        self.assertIn("connect-src 'none'", policy)
        self.assertEqual(page.headers["x-frame-options"], "SAMEORIGIN")
        self.assertIn("Bebas Neue", page.text)
        self.assertEqual(client.get("/api/design-looks/kairos/preview").status_code, 200)
        self.assertEqual(client.get("/api/design-looks/no-such-look/preview").status_code, 404)
        self.assertEqual(client.get("/api/design-fonts/sport/bebasneue-0.ttf").status_code, 200)

    def test_html_zip_carries_a_looks_fonts_by_alias(self):
        sid = new_chat()
        made = call("design_create", {"title": "Camp", "look": "sport", "boards": [
            {"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<main><h1>Camp</h1></main>"}]}, sid)
        design_id = re.search(r"Created design ([a-f0-9]{12})", made).group(1)
        archive = zipfile.ZipFile(io.BytesIO(design_export.html_zip(design_id)))
        names = archive.namelist()
        self.assertIn("fonts/sport/bebasneue-0.ttf", names)
        page = archive.read("poster.html").decode()
        self.assertIn('url("fonts/sport/bebasneue-0.ttf")', page)


class DirectionTests(unittest.TestCase):
    def setUp(self):
        settings_store.update_settings(design_default_look=None)

    def test_different_subjects_get_different_looks(self):
        for tkey, template in TYPES.items():
            firsts = {key: creative_direction.directions(template.format(s=s))[0]["look"] for key, s in SUBJECTS.items()}
            self.assertEqual(len(set(firsts.values())), len(SUBJECTS), f"{tkey}: {firsts}")
            self.assertNotIn("kairos", firsts.values())
        self.assertEqual(creative_direction.directions(TYPES["poster"].format(s=SUBJECTS["minecraft"]))[0]["look"], "retro-pixel")
        self.assertEqual(creative_direction.directions(TYPES["slides"].format(s=SUBJECTS["mocktrial"]))[0]["look"], "counsel")

    def test_same_brief_same_answer_and_three_distinct_directions(self):
        brief = TYPES["poster"].format(s=SUBJECTS["soccer"])
        first = creative_direction.directions(brief)
        self.assertEqual(first, creative_direction.directions(brief))
        self.assertEqual(len({d["look"] for d in first}), 3)

    def test_kairos_only_when_asked(self):
        self.assertEqual(creative_direction.directions("Make a poster for the Kairos launch")[0]["look"], "kairos")
        settings_store.update_settings(design_default_look="kairos")
        self.assertEqual(creative_direction.directions("A poster for a bake sale")[0]["look"], "kairos")

    def test_the_output_type_is_read_from_the_brief(self):
        for brief, kind in (("Write a 3 to 6 page guide as a PDF", "print"), ("Make a 10-slide deck", "slides"),
                            ("Design the home screen for our app", "screen"), ("A landing page for a bakery", "website"),
                            ("Make an Instagram post", "social"), ("A flyer for the fair", "poster")):
            self.assertEqual(creative_direction.kind_of(brief), kind, brief)

    def test_recently_used_looks_rank_lower(self):
        brief = TYPES["poster"].format(s=SUBJECTS["minecraft"])
        top = creative_direction.directions(brief, owner="recent-user")[0]["look"]
        for n in range(3):
            design_store.create(f"Old {n}", owner="recent-user", chat_key_=None, by="test", design_system=top)
        self.assertNotEqual(creative_direction.directions(brief, owner="recent-user")[0]["look"], top)
        self.assertEqual(creative_direction.directions(brief, owner="someone-else")[0]["look"], top)


class ToolTests(unittest.TestCase):
    def setUp(self):
        settings_store.update_settings(design_default_look=None)

    def test_design_create_without_a_look_creates_nothing_and_offers_directions(self):
        for surface in (tool_registry.OPENAI, tool_registry.CLAUDE, tool_registry.CODEX):
            sid = new_chat()
            reply = call("design_create", {"title": "Soccer camp poster", "brief": TYPES["poster"].format(s=SUBJECTS["soccer"]),
                                           "boards": [{"title": "Poster", "format": "poster", "orientation": "portrait",
                                                       "html": "<main><h1>Camp</h1></main>"}]}, sid, surface)
            self.assertTrue(reply.startswith("Not created yet: pick a look first."), reply)
            self.assertIn('look="', reply)
            self.assertEqual(design_store.designs_for_chat(sid), [], surface)
        made = call("design_create", {"title": "Camp", "look": "playful", "boards": [
            {"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<main><h1>Camp</h1></main>"}]}, sid)
        self.assertIn("design system playful", made)
        self.assertTrue(call("design_create", {"title": "X", "look": "nope"}, sid).startswith("Not run: no look"))

    def test_a_default_look_fills_in_and_is_admin_only(self):
        app = FastAPI()
        app.include_router(design_routes.systems_router)
        client = TestClient(app)
        self.assertEqual(client.post("/api/design-systems/default/look", json={"id": "nordic"}).json()["id"], "nordic")
        self.assertEqual(client.post("/api/design-systems/default/look", json={"id": "missing"}).status_code, 404)
        data, _ = design_store.create("By hand", owner="local", chat_key_=None, by="You")
        self.assertEqual(data["design_system"], "nordic")
        sid = new_chat()
        made = call("design_create", {"title": "Auto", "boards": [{"title": "S", "format": "app", "orientation": "portrait",
                                                                   "html": "<main><h1>Hi</h1></main>"}]}, sid)
        self.assertIn("design system nordic", made)
        self.assertEqual(client.post("/api/design-systems/default/look", json={"id": None}).json()["id"], None)
        self.assertEqual(client.delete("/api/design-systems/editorial").status_code, 422, "bundled looks stay")
        from core.auth import auth_manager
        from unittest.mock import patch
        with patch.object(auth_manager, "is_admin", return_value=False):
            self.assertEqual(client.post("/api/design-systems/default/look", json={"id": "sport"}).status_code, 403)

    def test_creative_direction_reaches_every_model_and_small_windows(self):
        for surface in (tool_registry.OPENAI, tool_registry.CLAUDE, tool_registry.CODEX):
            names = {s.name for s in tool_registry.specs(surface, True, session_id=new_chat())}
            self.assertIn("creative_direction", names, surface)
        brain = ExternalBrain("http://127.0.0.1:11434/v1", "qwen2.5:7b", None, session_id=new_chat(), window=16384, is_admin=False)
        self.assertIn("creative_direction", {t["function"]["name"] for t in brain.tools})
        reply = call("creative_direction", {"brief": TYPES["slides"].format(s=SUBJECTS["saas"]), "type": "slides"}, new_chat())
        self.assertTrue(reply.startswith("Three directions for this slides."), reply)
        self.assertIn('look="fintech-mint"', reply)


class CheckTests(unittest.TestCase):
    TOKENS = design_systems.variables(design_systems.get("editorial")["tokens"])

    def notes(self, html, board):
        return design_checks.check(design_html.parse(html), board, self.TOKENS)

    def test_type_floor_per_format(self):
        slide = {"format": "slides", "w": 1920, "h": 1080}
        self.assertTrue(any("under the slides floor of 24px" in n for n in self.notes('<p style="font-size: 18px">Small</p>', slide)))
        self.assertEqual(self.notes('<p style="font-size: 28px">Fine</p>', slide), [])
        self.assertTrue(any("12px" in n for n in self.notes('<p style="font: 600 var(--ds-size-1) var(--ds-font-sans)">x</p>',
                                                            {"format": "social", "w": 1080, "h": 1080})))
        self.assertEqual(self.notes('<p style="font-size: 11px"></p>', slide), [], "no text, no note")

    def test_placeholders_and_decoration(self):
        poster = {"format": "poster", "w": 1200, "h": 1800}
        box = '<div style="width: 600px; height: 400px; background: var(--ds-surface)"></div>'
        self.assertTrue(any("Empty placeholder box" in n for n in self.notes(box, poster)))
        bars = "".join(f'<div style="width: 70%; height: 12px; background: var(--ds-surface-2)"></div>' for _ in range(3))
        self.assertTrue(any("grey placeholder bars" in n for n in self.notes(bars, poster)))
        grey = "".join(f'<div style="width: 300px; height: 14px; background: #DDDDDD"></div>' for _ in range(3))
        self.assertTrue(any("grey placeholder bars" in n for n in self.notes(grey, poster)))
        no_picture = ["This poster has no picture. Add one: image_generate (if connected), image_search for a licensed photo, "
                      "image_treat on the person's photo, or image_pattern for a texture. A finished "
                      "poster has a picture or a texture; place it with design_edit."]
        # Decoration is not a placeholder, but it still leaves a poster without a picture.
        tree = "".join(f'<div style="position:absolute;left:0;top:-{40 + 20 * n}px;width:{220 - 40 * n}px;height:20px;background:var(--ds-accent)"></div>'
                       for n in range(4))
        self.assertEqual(self.notes(f'<div style="position: relative">{tree}</div>', poster), no_picture)
        moon = '<div style="width: 600px; height: 600px; border-radius: 50%; background: var(--ds-accent)"></div>'
        rule = '<div aria-hidden="true" style="width: 600px; height: 400px; background: var(--ds-accent)"></div>'
        image = '<div style="width: 600px; height: 400px; background: var(--ds-surface)"><img src="data:image/png;base64,AAAA" alt="x"></div>'
        for html in (moon, rule, image, '<div style="width: 600px; height: 400px; background: var(--ds-surface)"><p>Facts</p></div>'):
            self.assertEqual(self.notes(html, poster), [] if html == image else no_picture, html)

    def test_typefaces_and_empty_render(self):
        many = "".join(f'<p style="font-family: {f}">x</p>' for f in ("Arial", "Georgia", "Courier", "Impact"))
        self.assertTrue(any("4 typefaces" in n for n in self.notes(many, {"format": "poster", "w": 1200, "h": 1800})))
        from PIL import Image
        blank = environment / "blank.png"
        Image.new("RGB", (480, 720), "#F7F3EC").save(blank)
        self.assertGreater(design_checks.empty_share(blank), 0.95)
        notes = design_checks.check(design_html.parse("<h1>Hi</h1>"), {"format": "poster", "w": 1200, "h": 1800}, self.TOKENS, blank)
        self.assertTrue(any("blank in its render" in n for n in notes))

    def test_create_returns_the_check_notes(self):
        made = call("design_create", {"title": "Deck", "look": "swiss-grid", "boards": [
            {"title": "One", "format": "slides", "orientation": "landscape",
             "html": '<section><h1 style="font-size: 120px">Report</h1><p style="font-size: 16px">Tiny caption</p></section>'}]}, new_chat())
        self.assertIn("under the slides floor of 24px", made)


class SkillTests(unittest.TestCase):
    def test_skills_teach_direction_and_drop_the_old_defaults(self):
        canvas = (REPO / "skill_templates" / "design-canvas" / "SKILL.md").read_text(encoding="utf-8")
        for word in ("creative_direction", "var(--ds-font-display)", "var(--ds-on-accent)", "poster-stack", "big-number",
                     "slide-title", "comparison", "timeline", "quote", "hero-split", "bento", "editorial-column", "grid-12"):
            self.assertIn(word, canvas)
        self.assertNotIn("Keep the design system's look", canvas)
        for name in creative_direction.ARCHETYPES.values():
            for archetype in name:
                self.assertIn(f"**{archetype}**", canvas, archetype)
        poster = (REPO / "skill_templates" / "poster" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("creative_direction", poster)
        for gone in ("Arial Black", "C8102E", "add_textbox"):
            self.assertNotIn(gone, poster)


def tearDownModule():
    # Windows will not delete a database that is still open.
    from core import session_manager_store
    session_manager_store.close()
    shutil.rmtree(environment)


if __name__ == "__main__":
    unittest.main()
