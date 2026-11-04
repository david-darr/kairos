"""Styles from references (vault: "Creative Output Quality and Video Studio (Build Spec)", Phase 1b).

What these prove, with no model, browser or Electron started:

- photos, PDF pages, PowerPoint and Word themes become styles: a PowerPoint's
  exact theme colours and fonts, a photo's palette in sensible roles, and the
  same picture as a photo or a PDF giving the same colours;
- every style passes WCAG AA (repaired, never refused), over 150 random palettes;
- fonts are matched to bundled families, never copied (D11); edits are checked;
- unreadable or hostile files are refused in plain words (a zip bomb, a text file);
- a style is its owner's until an admin shares it (D10), in the list, the
  routes, creative_direction and design_create; only its owner or an admin
  removes it; the references are not kept (D12);
- the chat tool reads only this chat's attachments and asks before saving;
- private previews need their signed token; bundled looks don't.

Run: .venv\\Scripts\\python.exe scripts\\test_design_references.py
"""
import asyncio
import io
import os
import random
import re
import shutil
import sys
import unittest
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = Path(__file__).resolve().parents[1] / (".refs-test-" + uuid.uuid4().hex[:12])
environment.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(environment)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from core import (attachments, creative_direction, design_looks, design_references as R, design_render,  # noqa: E402
                  design_systems, permissions, tool_registry)
from core.auth import auth_manager  # noqa: E402
from core.middleware import SecurityHeadersMiddleware, require_admin, require_user  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import design_routes  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
FILES = environment / "files"
FILES.mkdir()


def bakery_png() -> bytes:
    img = Image.new("RGB", (800, 600), "#F6EBDD")
    d = ImageDraw.Draw(img)
    d.rectangle([60, 60, 500, 140], fill="#4A2E22")
    d.rectangle([60, 400, 300, 470], fill="#D6455A")
    d.ellipse([600, 300, 720, 420], fill="#8FD3B6")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def office_with_theme(kind: str, colors: dict, fonts: tuple) -> Path:
    path = FILES / f"brand-{uuid.uuid4().hex[:6]}.{kind}"
    if kind == "pptx":
        from pptx import Presentation
        Presentation().save(path)
    else:
        from docx import Document
        Document().save(path)
    with zipfile.ZipFile(path) as archive:
        items = {n: archive.read(n) for n in archive.namelist()}
    theme = next(n for n in items if re.match(r"(ppt|word)/theme/theme\d*\.xml", n))
    text = items[theme].decode()
    for role, value in colors.items():
        text = re.sub(rf"(<a:{role}>).*?(</a:{role}>)", rf'\1<a:srgbClr val="{value}"/>\2', text, flags=re.S)
    text = re.sub(r'(<a:majorFont>\s*<a:latin typeface=")[^"]*', rf"\g<1>{fonts[0]}", text)
    text = re.sub(r'(<a:minorFont>\s*<a:latin typeface=")[^"]*', rf"\g<1>{fonts[1]}", text)
    items[theme] = text.encode()
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in items.items():
            archive.writestr(name, data)
    return path


def run(coro):
    return asyncio.run(coro)


def call(name, args, session_id, is_admin=False):
    ctx = tool_registry.ToolContext(session_id=session_id, is_admin=is_admin, turn_taint=TurnTaint(), surface=tool_registry.OPENAI)
    result = run(tool_registry.call(name, args, ctx, tool_registry.OPENAI))
    return result.text if isinstance(result, tool_registry.ToolResult) else result


def chat_with(owner, filename, content):
    staged = attachments.stage_file(filename, content)
    sid = session_manager.create_session("refs", owner_user=owner)["id"]
    session_manager.append_message(sid, "user", "make a style",
                                   extra={"attachments": [{"id": staged["id"], "filename": filename}]})
    return sid


def aa(color: dict) -> bool:
    return all(design_looks._contrast(color[f], color[b]) >= 4.5 for f, b in design_looks.AA_PAIRS)


class EngineTests(unittest.TestCase):
    def test_a_powerpoint_and_a_word_theme_carry_their_exact_brand(self):
        for kind in ("pptx", "docx"):
            path = office_with_theme(kind, {"dk1": "0A1F44", "lt1": "FFFFFF", "accent1": "0B5FFF", "accent2": "FF7A00"},
                                     ("Montserrat", "Georgia"))
            evidence = R.read(path, path.name)
            self.assertEqual(evidence["kind"], kind)
            look = R.draft([evidence], "Brand")["look"]
            self.assertEqual((look["color"]["bg"], look["color"]["text"], look["color"]["accent"], look["color"]["accent-2"]),
                             ("#FFFFFF", "#0A1F44", "#0B5FFF", "#FF7A00"), kind)
            self.assertEqual(look["fonts"], {"display": "outfit", "body": "sourceserif4"}, "Montserrat -> Outfit, Georgia -> Source Serif 4")
            self.assertTrue(aa(look["color"]))

    def test_a_photo_and_the_same_picture_as_a_pdf_give_the_same_palette(self):
        (FILES / "menu.png").write_bytes(bakery_png())
        Image.open(io.BytesIO(bakery_png())).save(FILES / "menu.pdf")
        photo = R.draft([R.read(FILES / "menu.png", "menu.png")], "Bakery")["look"]["color"]
        pdf = R.draft([R.read(FILES / "menu.pdf", "menu.pdf")], "Bakery")["look"]["color"]
        self.assertEqual(photo["bg"], "#F6EBDD")
        self.assertLess(R._distance(photo["text"], "#4A2E22"), 12)
        self.assertLess(R._distance(photo["accent"], "#D6455A"), 24, "the strawberry red is the accent")
        self.assertLess(R._distance(photo["accent-2"], "#8FD3B6"), 30, "the mint is the second accent")
        for role in ("bg", "text", "accent", "accent-2"):
            self.assertLess(R._distance(photo[role], pdf[role]), 30, role)

    def test_every_style_is_readable_whatever_the_reference(self):
        rng = random.Random(7)
        for n in range(150):
            img = Image.new("RGB", (240, 160), tuple(rng.randrange(256) for _ in range(3)))
            d = ImageDraw.Draw(img)
            for _ in range(rng.randrange(1, 6)):
                x, y = rng.randrange(200), rng.randrange(120)
                d.rectangle([x, y, x + rng.randrange(10, 120), y + rng.randrange(10, 80)], fill=tuple(rng.randrange(256) for _ in range(3)))
            path = FILES / f"r{n}.png"
            img.save(path)
            look = R.draft([R.read(path, path.name)], f"Random {n}")["look"]
            self.assertTrue(aa(look["color"]), (n, look["color"]))

    def test_fonts_are_matched_never_copied(self):
        for name, role, want in (("Inter", "body", "inter"), ("Playfair Display", "display", "playfairdisplay"),
                                 ("Courier New", "body", "jetbrainsmono"), ("Helvetica Neue Condensed", "display", "oswald"),
                                 ("Times New Roman", "body", "sourceserif4"), ("Futura PT", "display", "outfit"),
                                 ("ZapfQuirkyName", "body", None)):
            self.assertEqual(R.match_font(name, role), want, name)
        with self.assertRaisesRegex(R.ReferenceError, "bundled families only"):
            R.adjust(R.draft([R.read(FILES / "menu.png", "menu.png")] if (FILES / "menu.png").exists() else
                             [{"kind": "image", "name": "x", "palette": [("#FFFFFF", 0.9), ("#222222", 0.1)]}], "X")["look"],
                     fonts={"display": "Comic Sans MS"})

    def test_edits_are_checked_and_repaired(self):
        look = R.draft([{"kind": "image", "name": "x", "palette": [("#FFFFFF", 0.8), ("#222222", 0.15), ("#E4002B", 0.05)]}], "X")["look"]
        fixed, notes = R.adjust(look, colors={"text-dim": "#EEEEEE"})
        self.assertGreaterEqual(design_looks._contrast(fixed["color"]["text-dim"], fixed["color"]["bg"]), 4.5)
        self.assertTrue(any("text-dim changed" in n for n in notes))
        for bad in ({"colors": {"bg": "red"}}, {"colors": {"glow": "#FFFFFF"}}, {"shape": {"button": "blob"}}):
            with self.assertRaises(R.ReferenceError, msg=bad):
                R.adjust(look, **bad)

    def test_unreadable_and_hostile_files_are_refused_in_plain_words(self):
        (FILES / "notes.txt").write_text("hello")
        with self.assertRaisesRegex(R.ReferenceError, "isn't a photo"):
            R.read(FILES / "notes.txt", "notes.txt")
        bomb = FILES / "bomb.pptx"
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("ppt/presentation.xml", "<p/>")
            archive.writestr("ppt/theme/theme1.xml", "0" * (60 * 1024 * 1024))
        with self.assertRaises(R.ReferenceError):
            R.read(bomb, "bomb.pptx")
        empty = FILES / "plain.docx"
        with zipfile.ZipFile(empty, "w") as archive:
            archive.writestr("word/document.xml", "<w/>")
        with self.assertRaisesRegex(R.ReferenceError, "no theme"):
            R.read(empty, "plain.docx")


class StorageAndRouteTests(unittest.TestCase):
    def client(self, user, admin):
        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)
        app.include_router(design_routes.systems_router)
        app.include_router(design_routes.render_router)
        app.dependency_overrides[require_user] = lambda: user
        app.dependency_overrides[require_admin] = (lambda: user) if admin else (lambda: (_ for _ in ()).throw(
            __import__("fastapi").HTTPException(403, "admin privileges required")))
        return TestClient(app)

    def test_a_tool_store_style_is_private_then_shared_and_keeps_no_files(self):
        with patch.object(auth_manager, "is_admin", side_effect=lambda u: u == "root"):
            alice, bob, root = self.client("alice", False), self.client("bob", False), self.client("root", True)
            made = alice.post("/api/design-systems/drafts", data={"name": "Bakery menus", "notes": "warm, for menus"},
                              files=[("files", ("menu.png", bakery_png(), "image/png")),
                                     ("files", ("notes.txt", b"hello", "text/plain"))])
            self.assertEqual(made.status_code, 200, made.text)
            draft = made.json()
            self.assertTrue(draft["id"].startswith("draft-"))
            self.assertEqual(draft["sources"], ["menu.png"])
            self.assertTrue(any("notes.txt" in s for s in draft["skipped"]))
            self.assertTrue(any(f["id"] == "fraunces" for f in draft["font_options"]))
            self.assertEqual(bob.post(f"/api/design-systems/drafts/{draft['id']}/save").status_code, 404, "someone else's draft")
            adjusted = alice.post(f"/api/design-systems/drafts/{draft['id']}", json={"fonts": {"display": "lora"}, "shape": {"button": "pill"}})
            self.assertEqual(adjusted.json()["look"]["fonts"]["display"], "lora")
            saved = alice.post(f"/api/design-systems/drafts/{draft['id']}/save").json()
            style = saved["id"]
            folder = Path(design_systems.SYSTEMS_DIR, style)
            self.assertEqual(sorted(p.name for p in folder.iterdir()), ["look.json", "system.json"], "values only, no reference files")
            self.assertFalse(any(Path(design_systems.DATA_DIR if hasattr(design_systems, "DATA_DIR") else environment).rglob("kairos-style-*")))
            ids = lambda c: [s["id"] for s in c.get("/api/design-systems").json()]  # noqa: E731
            self.assertIn(style, ids(alice))
            self.assertNotIn(style, ids(bob))
            self.assertIn(style, ids(root), "an admin sees it to share it")
            self.assertEqual(bob.get(f"/api/design-systems/{style}").status_code, 404)
            self.assertTrue(alice.get(f"/api/design-systems/{style}").json()["mine"])
            self.assertEqual(bob.post(f"/api/design-systems/{style}/share", json={"shared": True}).status_code, 403)
            self.assertTrue(root.post(f"/api/design-systems/{style}/share", json={"shared": True}).json()["shared"])
            self.assertIn(style, ids(bob))
            self.assertEqual(bob.delete(f"/api/design-systems/{style}").status_code, 403, "only its owner or an admin")
            self.assertEqual(alice.delete(f"/api/design-systems/{style}").status_code, 200)
            self.assertNotIn(style, ids(alice))

    def test_private_previews_need_their_token(self):
        result = R.draft([{"kind": "image", "name": "x", "palette": [("#101418", 0.8), ("#F4F4F4", 0.15), ("#C6FF3D", 0.05)]}], "Night")
        style = design_systems.save_style(result["look"], owner="alice", sources=["x.png"])["id"]
        draft = R.save_draft(result, "alice")["id"]
        client = self.client("alice", False)
        self.assertEqual(client.get("/api/design-looks/sport/preview").status_code, 200, "bundled looks are public")
        for target in (style, draft):
            self.assertEqual(client.get(f"/api/design-looks/{target}/preview").status_code, 404, target)
            self.assertEqual(client.get(f"/api/design-looks/{target}/preview?rt={design_render.sign('sport', 'style-preview')}").status_code, 404)
            page = client.get(f"/api/design-looks/{target}/preview?rt={design_render.sign(target, 'style-preview')}")
            self.assertEqual(page.status_code, 200, target)
            self.assertIn("@font-face", page.text)
            self.assertIn("script-src 'none'", page.headers["content-security-policy"])
        font = re.search(r'url\("/api/design-fonts/(draft-[0-9a-f]{12})/([a-z0-9]+-\d+\.(?:ttf|woff2))"\)',
                         client.get(f"/api/design-looks/{draft}/preview?rt={design_render.sign(draft, 'style-preview')}").text)
        self.assertEqual(client.get(f"/api/design-fonts/{font.group(1)}/{font.group(2)}").status_code, 200)


class ChatToolTests(unittest.TestCase):
    def test_the_chat_tool_reads_only_this_chats_files_and_asks_before_saving(self):
        sid = chat_with("carol", "menu-photo.png", bakery_png())
        other = session_manager.create_session("other", owner_user="carol")["id"]
        self.assertIn("Not attached to this chat", call("design_style_from_references", {"name": "Bakery", "references": ["menu-photo.png"]}, other))
        self.assertIn("Not attached", call("design_style_from_references", {"name": "X", "references": [str(FILES / "menu.png")]}, sid))
        made = call("design_style_from_references", {"name": "Bakery menus", "references": ["menu-photo.png"], "notes": "warm"}, sid)
        draft = re.search(r"Draft (draft-[0-9a-f]{12})", made).group(1)
        self.assertIn("Fonts (bundled only)", made)
        self.assertIn("/preview?rt=", made)
        with patch.object(permissions, "decide", return_value=SimpleNamespace(behavior="deny", reason="no")) as decide:
            self.assertTrue(call("design_style_from_references", {"draft": draft, "save": True}, sid).startswith("Not saved"))
            self.assertTrue(decide.call_args.kwargs["force_prompt"])
        with patch.object(permissions, "decide", return_value=SimpleNamespace(behavior="allow", reason="")):
            saved = call("design_style_from_references", {"draft": draft, "save": True}, sid)
        style = re.search(r"Saved style ([a-z0-9-]+)", saved).group(1)
        self.assertEqual(design_systems.get(style)["owner"], "carol")
        board = [{"title": "P", "format": "poster", "orientation": "portrait", "html": "<main><h1>Menu</h1></main>"}]
        self.assertIn("Created design", call("design_create", {"title": "Menu", "look": style, "boards": board}, sid))
        dave = session_manager.create_session("dave", owner_user="dave")["id"]
        self.assertTrue(call("design_create", {"title": "X", "look": style, "boards": board}, dave).startswith("Not run: no look"),
                        "someone else's private style")

    def test_creative_direction_offers_a_persons_styles(self):
        look = R.draft([{"kind": "image", "name": "x", "palette": [("#FFF7EE", 0.8), ("#3B2418", 0.15), ("#E0533D", 0.05)]}],
                       "Harbor Cafe", "coffee shop menus")["look"]
        style = design_systems.save_style(look, owner="erin", sources=["x.png"])["id"]
        first = creative_direction.directions("Make a poster in my Harbor Cafe style", owner="erin")[0]
        self.assertEqual(first["look"], style)
        self.assertIn("the brief names", first["why"])
        self.assertNotIn(style, [d["look"] for d in creative_direction.directions("Make a poster in my Harbor Cafe style", owner="frank")])
        design_systems.share_style(style, True)
        self.assertEqual(creative_direction.directions("A Harbor Cafe flyer", owner="frank")[0]["look"], style)

    def test_the_skill_and_tool_teach_it(self):
        skill = (REPO / "skill_templates" / "design-canvas" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("design_style_from_references", skill)
        spec = next(s for s in tool_registry.specs(tool_registry.OPENAI, True) if s.name == "design_style_from_references")
        for word in ("photos", "PowerPoint", "bundled families only", "asks the"):
            self.assertIn(word, spec.description)


def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()
    shutil.rmtree(environment)


if __name__ == "__main__":
    unittest.main()
