"""The Design canvas (vault: "Design Canvas (Build Spec)", phases 1 to 4).

What these prove, with no model, browser or Electron started:

- the normaliser parses what models write, removes what can run or reach out,
  gives every element a stable id and enforces the size and board caps;
- every design_edit operation works, a bad call changes nothing and teaches,
  and a change to one element's style is a version touching that one id;
- versions copy only changed boards, restore and prune without losing any
  version that is kept, and comments on a changed element turn "addressed";
- the built-in Kairos system is the app's own theme, and switching a
  10-board design's system restyles every board with no model call;
- a board renders with only Kairos's hash-pinned viewer script, behind its
  own CSP header, framed only by the app, and the render token works;
- the tools reach every surface from one table and are gated per chat; the
  scripted runs below SIMULATE each model surface (Claude through its MCP
  handler, Codex through POST /api/tools, an OpenAI API model and a 7-8B
  local model through the real provider loop with a scripted endpoint);
- a design_comment reference is resolved and fenced on the server;
- exports: the HTML zip offline, and PNG, PDF and PPTX through a simulated
  render worker on the real job stream.

Run: .venv\\Scripts\\python.exe scripts\\test_design_canvas.py
"""
import asyncio
import base64
import io
import json
import os
import re
import shutil
import sys
import time
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
environment = Path(__file__).resolve().parents[1] / (".design-test-" + uuid.uuid4().hex[:12])
environment.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(environment)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import (chat_references, design_comments, design_export, design_html, design_render,  # noqa: E402
                  design_render_bridge, design_store, design_systems, design_tools, tool_registry)
from core.external_brain import ExternalBrain  # noqa: E402
from core.middleware import SecurityHeadersMiddleware  # noqa: E402
from core.providers import openai_compatible  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import design_routes, tool_routes  # noqa: E402

REPO = Path(__file__).resolve().parents[1]

ONBOARDING = [
    {"title": "Welcome", "frame": "phone", "html": (
        '<main style="padding: var(--ds-space-6); background: var(--ds-bg); color: var(--ds-text)">'
        '<h1>Build a habit</h1><p>One small step a day.</p>'
        '<button data-kd-goto="pick-a-habit" style="min-height: 52px">Continue</button></main>')},
    {"title": "Pick a habit", "frame": "phone", "html": (
        '<main style="padding: var(--ds-space-6)"><h1>Pick a habit</h1><ul><li>Read<li>Walk<li>Stretch</ul>'
        '<button data-kd-goto="reminders" style="min-height: 52px; width: 60%">Continue</button></main>')},
    {"title": "Reminders", "frame": "phone", "html": (
        '<main style="padding: var(--ds-space-6)"><h1>When should we remind you?</h1>'
        '<button style="min-height: 52px">Finish</button></main>')},
]


def run(coro):
    return asyncio.run(coro)


def ctx(session_id, surface=tool_registry.OPENAI, **kw):
    return tool_registry.ToolContext(session_id=session_id, is_admin=kw.pop("is_admin", True), turn_taint=TurnTaint(),
                                     surface=surface, **kw)


def call(name, args, context, surface=tool_registry.OPENAI):
    return run(tool_registry.call(name, args, context, surface))


def text(result):
    return result.text if isinstance(result, tool_registry.ToolResult) else result


def new_chat(title="design chat", owner="local"):
    return session_manager.create_session(title, owner_user=owner)["id"]


def create(session_id, boards=ONBOARDING, surface=tool_registry.OPENAI, **kw):
    result = call("design_create", {"title": "Habit onboarding", "boards": boards}, ctx(session_id, surface, **kw), surface)
    match = re.search(r"Created design ([a-f0-9]{12})", text(result))
    assert match, text(result)
    return match.group(1), text(result)


def button_id(design_id, slug, label="Continue"):
    root = design_html.parse(design_store.board_html(design_id, slug))
    return next(n.kd for n in root.elements() if n.tag == "button" and n.text() == label)


class NormaliserTests(unittest.TestCase):
    def test_script_handlers_and_outside_urls_are_removed(self):
        source = ('<html><head><script>alert(1)</script><link rel="stylesheet" href="https://x"></head><body>'
                  '<div onclick="steal()"><a href="javascript:alert(1)">x</a><img src="https://evil/p.png" alt="a">'
                  '<iframe src="https://evil"></iframe><object data="x"></object><embed src="y">'
                  '<form action="https://evil/collect"><input name="q"></form>'
                  '<p style="background: url(https://evil/t.png)">t</p><style>@import url(https://e/x.css); p{color:red}</style>'
                  '<svg><a href="javascript:x()"><text>s</text></a></svg></div></body></html>')
        stored, root, notes = design_html.normalize(source)
        lowered = stored.lower()
        for banned in ("<script", "onclick", "javascript:", "https://", "<iframe", "<object", "<embed", "action=", "@import", "<link"):
            self.assertNotIn(banned, lowered, banned)
        self.assertIn("<form", stored, "the form is kept, without a target")
        self.assertTrue(any("onclick" in n for n in notes), notes)
        self.assertTrue(all(n.kd for n in root.elements() if n.tag not in design_html.NO_ID and not design_html._svg_descendant(n)))

    def test_ids_are_short_stable_and_unique(self):
        stored, _, _ = design_html.normalize('<h3>A</h3><button>Go</button><button data-kd="btn1">Kept</button>')
        ids = re.findall(r'data-kd="([a-z0-9-]+)"', stored)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn('data-kd="btn1">Kept', stored, "an existing id is kept")
        again, _, _ = design_html.normalize(stored)
        self.assertEqual(again, stored, "normalising is stable")
        dup, _, _ = design_html.normalize('<p data-kd="p1">a</p><p data-kd="p1">b</p>')
        self.assertEqual(len(set(re.findall(r'data-kd="([a-z0-9-]+)"', dup))), 2, "a copied id is replaced")

    def test_malformed_model_html_parses_like_a_browser(self):
        stored, root, _ = design_html.normalize('<ul><li>one<li>two</ul><p>a<p>b</div></span><table><tr><td>1<td>2</table>')
        self.assertEqual([n.text() for n in root.elements() if n.tag == "li"], ["one", "two"])
        self.assertEqual([n.text() for n in root.elements() if n.tag == "p"], ["a", "b"])
        self.assertEqual(len([n for n in root.elements() if n.tag == "td"]), 2)

    def test_the_board_size_cap(self):
        with self.assertRaises(design_html.DesignError) as caught:
            design_html.normalize("<p>" + "x" * (design_html.MAX_BOARD_BYTES + 10) + "</p>")
        self.assertIn("200 KB", str(caught.exception))

    def test_lint_notes_do_not_refuse(self):
        _, root, _ = design_html.normalize('<p style="color: #ff0000">red</p><img src="assets/' + "a" * 64 + '.png">'
                                           '<p style="color: var(--ds-accent)">gold text</p>')
        notes = design_html.lint(root, design_systems.variables(design_systems.kairos_tokens()))
        joined = " ".join(notes)
        self.assertIn("raw colour", joined)
        self.assertIn("no alt text", joined)
        self.assertIn("contrast", joined)
        self.assertIn("Never text", design_systems.KAIROS_GUIDE)
        self.assertIn("accent is for hairlines", joined)


class OperationTests(unittest.TestCase):
    BOARD = ('<main><h1>Title</h1><p>Body</p><ul><li>A</li><li>B</li></ul><button>Continue</button>'
             '<button>Sign in</button><img src="assets/' + "b" * 64 + '.png" alt="x"></main>')

    def setUp(self):
        self.html, self.root, _ = design_html.normalize(self.BOARD)
        self.ids = {n.text() or n.tag: n.kd for n in self.root.elements()}

    def apply(self, *ops):
        return design_html.apply_ops(self.html, list(ops), "home")

    def test_every_operation(self):
        btn, h1, li = self.ids["Continue"], self.ids["Title"], self.ids["A"]
        out, touched, _ = self.apply({"op": "set_text", "id": h1, "text": "Welcome"})
        self.assertIn(">Welcome</h1>", out)
        out, _, _ = self.apply({"op": "set_style", "id": btn, "style": {"width": "100%", "color": "var(--ds-bg)"}})
        self.assertIn("width: 100%", out)
        out, _, _ = self.apply({"op": "set_attr", "id": self.ids["img"], "name": "alt", "value": "A sunrise"})
        self.assertIn('alt="A sunrise"', out)
        out, _, _ = self.apply({"op": "replace", "id": self.ids["Body"], "html": "<p>New body</p>"})
        self.assertIn(f'data-kd="{self.ids["Body"]}">New body', out, "replace keeps the id")
        out, _, _ = self.apply({"op": "insert", "ref_id": self.ids["A B"], "position": "last_child", "html": "<li>C</li>"})
        self.assertIn(">C</li></ul>", out)
        out, _, _ = self.apply({"op": "remove", "id": li})
        self.assertNotIn(">A</li>", out)
        out, _, _ = self.apply({"op": "move", "id": self.ids["Sign in"], "ref_id": btn, "position": "before"})
        self.assertLess(out.index("Sign in"), out.index("Continue"))
        out, _, _ = self.apply({"op": "replace_text", "find": ">Body<", "replace": ">Changed<"})
        self.assertIn(">Changed<", out)

    def test_bad_calls_change_nothing_and_teach(self):
        with self.assertRaises(design_html.DesignError) as caught:
            self.apply({"op": "set_style", "id": self.ids["Continue"], "style": {"width": "100%"}},
                       {"op": "set_text", "id": "btn9", "text": "x"})
        message = str(caught.exception)
        self.assertTrue(message.startswith("Nothing was changed. Operation 2"), message)
        self.assertIn("Buttons on this board:", message)
        self.assertIn(self.ids["Continue"], message)
        for op, expected in [({"op": "replace_text", "find": "li", "replace": "x"}, "exactly once"),
                             ({"op": "move", "id": self.ids["A B"], "ref_id": self.ids["A"], "position": "first_child"}, "into itself"),
                             ({"op": "set_attr", "id": self.ids["Continue"], "name": "onclick", "value": "x()"}, "data-kd-goto"),
                             ({"op": "set_attr", "id": self.ids["Continue"], "name": "data-kd", "value": "x"}, "cannot be changed"),
                             ({"op": "insert", "ref_id": self.ids["img"], "position": "first_child", "html": "<b>x</b>"}, "cannot hold children"),
                             ({"op": "shout"}, "op must be one of")]:
            with self.assertRaises(design_html.DesignError) as caught:
                self.apply(op)
            self.assertIn(expected, str(caught.exception))

    def test_a_style_change_is_one_changed_id(self):
        btn = self.ids["Continue"]
        out, _, _ = self.apply({"op": "set_style", "id": btn, "style": {"width": "100%"}})
        self.assertEqual(design_html.changed_ids(self.html, out), [btn])


class StoreTests(unittest.TestCase):
    def test_versions_copy_only_changed_boards_and_restore(self):
        sid = new_chat()
        design_id, _ = create(sid)
        slugs = [s for s, _ in design_store.ordered_boards(design_store.manifest(design_id))]
        self.assertEqual(slugs, ["welcome", "pick-a-habit", "reminders"])
        btn = button_id(design_id, "pick-a-habit")
        result = text(call("design_edit", {"board": "2", "ops": [{"op": "set_style", "id": btn, "style": {"width": "100%"}}]}, ctx(sid)))
        self.assertIn(f"changed {btn} on pick-a-habit", result)
        entry = design_store.version_entry(design_id, 2)
        self.assertEqual(entry["boards_changed"], ["pick-a-habit"])
        self.assertEqual(entry["changed_ids"], {"pick-a-habit": [btn]}, "the version diff touches one data-kd id")
        self.assertEqual(sorted(p.name for p in (design_store._folder(design_id) / "versions" / "files" / "2").iterdir()),
                         ["pick-a-habit.html"], "copy on write")
        restored = design_store.restore(design_id, 1, by="You")
        self.assertEqual(restored["version"], 3)
        self.assertNotIn("width: 100%", design_store.board_html(design_id, "pick-a-habit"))
        self.assertIn("width: 100%", design_store.board_at(design_id, "pick-a-habit", 2), "nothing is lost")

    def test_pruning_keeps_named_versions_and_rebuilds_later_ones(self):
        sid = new_chat()
        design_id, _ = create(sid)
        design_store.name_version(design_id, 1, "Approved v1")
        with patch.object(design_store, "MAX_VERSIONS", 4):
            for n in range(8):
                call("design_edit", {"board": "welcome", "ops": [{"op": "set_text", "id": button_id(design_id, "welcome", "Continue") if n == 0 else
                                                                   _first(design_id, "welcome", "button"), "text": f"Go {n}"}]}, ctx(sid))
        kept = [v["n"] for v in design_store.versions(design_id)]
        self.assertIn(1, kept)
        self.assertLessEqual(len(kept), 5)
        latest = max(kept)
        for n in kept:
            self.assertIsNotNone(design_store.board_at(design_id, "reminders", n), f"v{n} still rebuilds every board")
        self.assertIn("Go 7", design_store.board_at(design_id, "welcome", latest))

    def test_board_and_design_caps(self):
        sid = new_chat()
        design_id, _ = create(sid, boards=[{"title": "One", "frame": "phone"}])
        with patch.object(design_store, "MAX_BOARDS", 2):
            self.assertIn("Added board", text(call("design_add_board", {"title": "Two", "frame": "tablet"}, ctx(sid))))
            self.assertIn("at most 2 boards", text(call("design_add_board", {"title": "Three", "frame": "phone"}, ctx(sid))))
        before = design_store.manifest(design_id)["version"]
        self.assertTrue(text(call("design_edit", {"board": "one", "ops": [{"op": "set_text", "id": "nope1", "text": "x"}]}, ctx(sid))).startswith("Nothing was changed"))
        self.assertEqual(design_store.manifest(design_id)["version"], before, "a failed edit makes no version")

    def test_board_actions(self):
        sid = new_chat()
        design_id, _ = create(sid)
        c = ctx(sid)
        self.assertIn("Renamed", text(call("design_boards", {"action": "rename", "board": "welcome", "title": "Hello"}, c)))
        self.assertIn("Duplicated", text(call("design_boards", {"action": "duplicate", "board": "welcome"}, c)))
        self.assertIn("position 1", text(call("design_boards", {"action": "reorder", "board": "reminders", "order": 1}, c)))
        self.assertIn("Moved", text(call("design_boards", {"action": "move", "board": "welcome", "x": 2000, "y": 40}, c)))
        self.assertIn("Resized", text(call("design_boards", {"action": "resize", "board": "welcome", "w": 500, "h": 900}, c)))
        self.assertIn("canvas note", text(call("design_boards", {"action": "note", "text": "Flow A", "x": 0, "y": -200}, c)))
        data = design_store.manifest(design_id)
        self.assertEqual((data["boards"]["welcome"]["x"], data["boards"]["welcome"]["w"], data["boards"]["welcome"]["frame"]), (2000, 500, "phone"))
        self.assertEqual(design_store.ordered_boards(data)[0][0], "reminders")
        self.assertIn("Deleted", text(call("design_boards", {"action": "delete", "board": "hello-copy"}, c)))


def _first(design_id, slug, tag):
    return next(n.kd for n in design_html.parse(design_store.board_html(design_id, slug)).elements() if n.tag == tag)


class SystemTests(unittest.TestCase):
    def test_the_kairos_system_is_the_apps_theme(self):
        theme = (REPO / "static" / "css" / "kairos-theme.css").read_text(encoding="utf-8")
        values = dict(re.findall(r"(--k-[a-z0-9-]+)\s*:\s*([^;]+);", theme))
        variables = design_systems.variables(design_systems.kairos_tokens())
        for role, var in design_systems.KAIROS_MAP.items():
            self.assertEqual(variables[f"--ds-{role}"], values[var].strip(), role)
        for role in design_systems.ROLES:
            self.assertIn(f"--ds-{role}", variables)
        self.assertEqual(variables["--ds-font-sans"], values["--k-font-sans"].strip())
        self.assertIn("Jost-Variable.woff2", design_systems.font_faces("kairos", "/api/design-fonts"))

    def test_switching_a_ten_board_design_restyles_every_board_with_no_model_call(self):
        sid = new_chat()
        boards = [{"title": f"Screen {n}", "frame": "phone", "html": '<p style="color: var(--ds-text)">x</p>'} for n in range(10)]
        design_id, _ = create(sid, boards=boards)
        system = design_systems.save("Night", {"color": {"bg": "#101418", "text": "#F2F4F8"}}, created_by="test")
        result = design_tools.tokens_change(design_store.manifest(design_id), {"system": system["id"]}, by="You", session_id=None, user_edit=True)
        self.assertIn("Switched to Night", result)
        for slug, _ in design_store.ordered_boards(design_store.manifest(design_id)):
            page = design_render.render_document(design_id, slug)
            self.assertIn("--ds-bg: #101418;", page, slug)
        self.assertEqual(design_store.manifest(design_id)["version"], 2, "one version for the switch")

    def test_css_import_and_saved_tokens_are_plain(self):
        system = design_systems.from_css("Acme", ":root{--color-primary:#1a73e8;--background:#fff;--text-color:#202124;--font-sans:Inter, sans-serif}")
        variables = design_systems.variables(system["tokens"])
        self.assertEqual(variables["--ds-accent"], "#1a73e8")
        self.assertEqual(variables["--ds-bg"], "#fff")
        with self.assertRaises(ValueError):
            design_systems.save("Bad", {"color": {"bg": "red; background: url(https://x)"}})


class RenderTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_middleware(SecurityHeadersMiddleware)
        app.include_router(design_routes.router)
        app.include_router(design_routes.render_router)
        self.client = TestClient(app)
        self.sid = new_chat()
        self.design_id, _ = create(self.sid, boards=[{"title": "Evil", "frame": "phone", "html":
            '<script>fetch("/api/settings")</script><button onclick="x()">Hi</button><a href="javascript:alert(1)">l</a>'}])

    def test_a_board_runs_only_kairos_viewer_script(self):
        page = design_render.render_document(self.design_id, "evil")
        self.assertEqual(page.count("<script"), 1)
        self.assertIn(design_render.VIEWER_SCRIPT, page)
        self.assertNotIn("onclick", page)
        self.assertNotIn("javascript:", page)

    def test_the_render_route_sends_the_board_policy(self):
        response = self.client.get(f"/api/designs/{self.design_id}/boards/evil/render")
        self.assertEqual(response.status_code, 200)
        policy = response.headers["content-security-policy"]
        self.assertIn(f"script-src '{design_render.VIEWER_HASH}'", policy)
        for part in ("default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"):
            self.assertIn(part, policy)
        self.assertNotIn("script-src 'self'", policy)
        self.assertEqual(response.headers["x-frame-options"], "SAMEORIGIN")
        import hashlib
        script = re.search(r"<script>(.*?)</script>", response.text, re.S).group(1)
        self.assertEqual("sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode(), design_render.VIEWER_HASH)
        other = self.client.get("/api/designs")
        self.assertEqual(other.headers["x-frame-options"], "DENY", "only the board route is frameable")

    def test_render_tokens(self):
        token = design_render.sign(self.design_id, "evil")
        self.assertTrue(design_render.verify(self.design_id, "evil", token))
        self.assertFalse(design_render.verify(self.design_id, "other", token))
        self.assertFalse(design_render.verify(self.design_id, "evil", design_render.sign(self.design_id, "evil", -5)))
        self.assertEqual(self.client.get(f"/api/designs/{self.design_id}/boards/evil/render?rt=0000000000.{'A' * 24}").status_code, 404)

    def test_viewer_accepts_only_its_parent_and_never_navigates(self):
        script = design_render.VIEWER_SCRIPT
        self.assertIn("event.source !== parentWin", script)
        self.assertNotIn("location", script)
        self.assertNotIn("fetch(", script)


class SurfaceTests(unittest.TestCase):
    """SIMULATED: each surface calls the same tool table the way its brain does."""

    def test_every_surface_creates_three_boards_and_edits_one_button(self):
        for surface, label in ((tool_registry.CLAUDE, "Claude"), (tool_registry.CODEX, "Codex"), (tool_registry.OPENAI, "gpt-x")):
            sid = new_chat(f"{surface} chat")
            c = ctx(sid, surface, model=None if surface != tool_registry.OPENAI else "gpt-x")
            design_id, created = create(sid, surface=surface, model=None if surface != tool_registry.OPENAI else "gpt-x")
            self.assertIn(f"[Design: Habit onboarding](/designs/{design_id})", created)
            outline = text(call("design_outline", {"board": "2"}, c, surface))
            self.assertIn("<<<UNTRUSTED-", outline, "design content is fenced")
            self.assertTrue(c.turn_taint.tainted)
            btn = re.search(r"(btn\d+) <button> goto=reminders \"Continue\"", outline).group(1)
            done = text(call("design_edit", {"board": "pick-a-habit", "ops": [{"op": "set_style", "id": btn, "style": {"width": "100%"}}]}, c, surface))
            self.assertIn(f"changed {btn}", done)
            entry = design_store.versions(design_id)[0]
            self.assertEqual(entry["changed_ids"], {"pick-a-habit": [btn]})
            self.assertEqual(entry["by"], label)
            boards = design_store.manifest(design_id)["boards"]
            self.assertEqual(len(boards), 3)
            self.assertTrue(all(b["frame"] == "phone" for b in boards.values()))

    def test_a_chat_changes_only_its_own_designs(self):
        mine, theirs = new_chat(), new_chat()
        design_id, _ = create(mine)
        refused = text(call("design_edit", {"design_id": design_id, "board": "welcome", "ops": [{"op": "remove", "id": "h1"}]}, ctx(theirs)))
        self.assertIn("cannot change that design", refused)
        self.assertIn("No design is linked", text(call("design_outline", {}, ctx(theirs))))
        design_store.link_chat(design_id, theirs)
        self.assertIn("Design ", text(call("design_outline", {"design_id": design_id}, ctx(theirs))))

    def test_editing_tools_are_listed_only_once_a_design_is_linked(self):
        sid = new_chat()
        listed = lambda **kw: {t["function"]["name"] for t in tool_registry.openai_tools(True, session_id=sid, **kw)}
        self.assertIn("design_create", listed())
        self.assertNotIn("design_edit", listed())
        self.assertIn("design_edit", tool_registry.deferred_tools(True, session_id=sid), "a small window finds them through the bridge")
        self.assertNotIn("design_create", listed(small_window=True))
        design_store.set_design_mode(sid, True)
        self.assertIn("design_create", listed(small_window=True), "Design mode offers design_create directly")
        create(sid)
        self.assertIn("design_edit", listed())
        codex = {s.name for s in tool_registry.specs(tool_registry.CODEX, True, session_id=new_chat())}
        self.assertIn("design_create", codex)
        self.assertNotIn("design_edit", codex)

    def test_codex_reaches_the_tools_through_its_cli_route(self):
        from core import tool_access
        sid = new_chat("codex")
        app = FastAPI(); app.include_router(tool_routes.router)
        client = TestClient(app, client=("127.0.0.1", 50000))
        token = tool_access.issue(sid, is_admin=True)
        response = client.post("/api/tools/design_create", headers={"X-JARVIS-Tool-Token": token},
                               json={"arguments": {"title": "Codex design", "boards": ONBOARDING}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("Created design", response.json()["result"])

    def test_the_cli_parses_design_edit(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cli_under_test", REPO / "mcp_servers" / "hive_mind_cli.py")
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        parsed = cli.parser().parse_args(["design_edit", "--board", "2", "--ops", '[{"op":"set_style","id":"btn2","style":{"width":"100%"}}]'])
        tool = next(s for s in tool_registry.specs(tool_registry.CODEX, True, True) if s.name == "design_edit")
        self.assertEqual(cli.arguments(tool, parsed)["ops"][0]["style"], {"width": "100%"})


class ProviderLoopTests(unittest.TestCase):
    """SIMULATED endpoints, REAL provider loop (core/providers/openai_compatible.py)."""

    def scripted(self, replies):
        bodies = []

        async def fake_post(client, base_url, api_key, body):
            bodies.append(json.loads(json.dumps(body)))
            return replies.pop(0)
        return fake_post, bodies

    @staticmethod
    def tool_call(name, arguments, n=0):
        return {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": f"c{n}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}}]}

    @staticmethod
    def answer(content):
        return {"choices": [{"message": {"role": "assistant", "content": content}}]}

    def test_a_local_7b_model_on_a_16k_window_designs_through_the_bridge(self):
        sid = new_chat("local")
        brain = ExternalBrain("http://127.0.0.1:11434/v1", "qwen2.5:7b", None, session_id=sid, window=16384, is_admin=False)
        names = {t["function"]["name"] for t in brain.tools}
        self.assertIn("kairos_tool_search", names)
        self.assertNotIn("design_create", names)
        # A weak model's habit: the second step arrives as JSON text, not a
        # tool call; the provider's rescue turns it into the real call.
        fake, bodies = self.scripted([
            self.tool_call("kairos_tool_search", {"query": "design create screens"}),
            self.answer(json.dumps({"name": "kairos_tool_call", "arguments": {"name": "design_create", "arguments": {
                "title": "Habit onboarding", "boards": ONBOARDING}}})),
            self.answer("Here is your onboarding: [Design: Habit onboarding](/designs/x)"),
        ])
        with patch.object(openai_compatible, "_post_chat", fake):
            reply = run(brain.run_turn("Design a 3-screen onboarding for a habit app"))
        self.assertIn("Habit onboarding", reply)
        designs = design_store.designs_for_chat(sid)
        self.assertEqual(len(designs), 1)
        self.assertEqual(len(designs[0]["boards"]), 3)
        self.assertIn('"design_create"', bodies[1]["messages"][-1]["content"], "the search found design_create")
        design_id = designs[0]["id"]
        btn = button_id(design_id, "pick-a-habit")
        fake, _ = self.scripted([
            self.tool_call("kairos_tool_call", {"name": "design_edit", "arguments": {"board": "2", "ops": [
                {"op": "set_style", "id": btn, "style": {"width": "100%"}}]}}),
            self.answer("Done."),
        ])
        with patch.object(openai_compatible, "_post_chat", fake):
            run(brain.run_turn("Make the Continue button on screen 2 full width"))
        self.assertEqual(design_store.versions(design_id)[0]["changed_ids"], {"pick-a-habit": [btn]})

    def test_an_api_model_gets_the_editing_tools_in_the_same_turn(self):
        sid = new_chat("api")
        brain = ExternalBrain("https://api.openai.com/v1", "gpt-5", "sk-test", session_id=sid, window=400000, is_admin=True)
        fake, bodies = self.scripted([
            self.tool_call("design_create", {"title": "Habit onboarding", "boards": ONBOARDING}),
            self.tool_call("design_outline", {"board": "2"}, 1),
            self.answer("Created [Design: Habit onboarding](/designs/x)."),
        ])
        with patch.object(openai_compatible, "_post_chat", fake):
            run(brain.run_turn("Design a 3-screen onboarding for a habit app"))
        first = {t["function"]["name"] for t in bodies[0]["tools"]}
        second = {t["function"]["name"] for t in bodies[1]["tools"]}
        self.assertNotIn("design_edit", first)
        self.assertIn("design_edit", second, "offered in place once the design is linked")
        self.assertIn("btn", bodies[2]["messages"][-1]["content"], "the outline came back")

    def test_a_vision_model_gets_a_png_and_a_text_model_the_outline(self):
        sid = new_chat("vision")
        design_id, _ = create(sid)
        png = _png()

        async def render(*args, **kwargs):
            return png
        with patch.object(design_render_bridge, "render", render):
            result = call("design_snapshot", {"board": "welcome"}, ctx(sid))
        self.assertIsInstance(result, tool_registry.ToolResult)
        self.assertEqual(result.images, [png])
        seen, parts = openai_compatible._tool_messages(result, True, None)
        self.assertEqual(parts[0]["content"][0]["type"], "image_url")
        blind, none = openai_compatible._tool_messages(result, False, None)
        self.assertEqual(none, [])
        self.assertIn("outline", blind)
        self.assertNotIn("computer read", blind)
        missing = text(call("design_snapshot", {"board": "welcome"}, ctx(sid)))
        self.assertIn("need the Kairos desktop app", missing)
        self.assertIn("outline", missing)


class ReferenceTests(unittest.TestCase):
    def test_a_design_comment_is_resolved_and_fenced_on_the_server(self):
        sid = new_chat()
        design_id, _ = create(sid)
        btn = button_id(design_id, "pick-a-habit")
        ref = {"kind": "design_comment", "design_id": design_id, "board": "pick-a-habit", "element_ids": [btn],
               "comment": "Make this full width", "label": "Pick a habit · Continue"}
        context = chat_references.resolve(sid, [ref])
        self.assertIn(f"The user commented on element {btn} of board pick-a-habit", context)
        self.assertIn("Make this full width", context.split("<<<UNTRUSTED-")[0], "the user's words sit outside the fence")
        self.assertRegex(context, r"<<<UNTRUSTED-[0-9a-f]+>>>\n<button data-kd=\"" + btn)
        self.assertIn("use design_edit on the listed element ids", context)
        self.assertEqual(chat_references.metadata([ref])[0]["element_ids"], [btn])
        selection = chat_references.resolve(sid, [{**ref, "comment": ""}])
        self.assertIn("The user selected element", selection)
        with self.assertRaises(ValueError):
            chat_references.resolve(new_chat(), [ref])
        with self.assertRaises(ValueError):
            chat_references.resolve(sid, [{**ref, "element_ids": ["<script>"]}])

    def test_design_mode_pins_the_skill_on_the_first_message(self):
        sid = new_chat()
        self.assertEqual(chat_references.resolve(sid, []), "")
        design_store.set_design_mode(sid, True)
        self.assertIn("read_skill design-canvas", chat_references.resolve(sid, []))
        session_manager.append_message(sid, "user", "hi")
        session_manager.append_message(sid, "assistant", "hello")
        self.assertEqual(chat_references.resolve(sid, []), "")
        skill = (REPO / "skill_templates" / "design-canvas" / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(skill.startswith("---\nname: design-canvas\n"))
        for name in ("design_create", "design_edit", "data-kd-goto", "ui-ux-pro-max"):
            self.assertIn(name, skill)

    def test_comments_on_a_changed_element_turn_addressed(self):
        sid = new_chat()
        design_id, _ = create(sid)
        btn, h1 = button_id(design_id, "welcome"), _first(design_id, "welcome", "h1")
        first = design_store.add_comment(design_id, board="welcome", element_ids=[btn], point={"x": .5, "y": .9}, text="wider", author="local")
        second = design_store.add_comment(design_id, board="welcome", element_ids=[h1], point=None, text="bigger", author="local")
        call("design_edit", {"board": "welcome", "ops": [{"op": "set_style", "id": btn, "style": {"width": "100%"}}]}, ctx(sid))
        items = {c["id"]: c for c in design_store.comments(design_id)}
        self.assertEqual(items[first["id"]]["status"], "addressed")
        self.assertEqual(items[first["id"]]["addressed_in"], design_store.manifest(design_id)["version"])
        self.assertEqual(items[second["id"]]["status"], "open")
        listed = text(call("design_comments", {"action": "list"}, ctx(sid)))
        self.assertIn("bigger", listed)
        self.assertIn("is resolved", text(call("design_comments", {"action": "resolve", "comment_id": second["id"]}, ctx(sid))))

    def test_live_changes_reach_only_people_who_may_see_the_design(self):
        from services import chat_live
        sid = new_chat(owner="local")
        design_id, _ = create(sid)
        packet = {"type": "design_changed", "designId": design_id, "boards": []}
        self.assertIsNotNone(chat_live.visible_packet(packet, "local"))
        with patch.object(chat_live.auth_manager, "is_admin", return_value=False):
            self.assertIsNone(chat_live.visible_packet(packet, "someone-else"))


def _png(width=40, height=80):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 180, 150)).save(out, "PNG")
    return out.getvalue()


def _pdf():
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument.new()
    doc.new_page(390, 844)
    out = io.BytesIO(); doc.save(out); doc.close()
    return out.getvalue()


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.sid = new_chat()
        self.design_id, _ = create(self.sid)

    def test_the_html_zip_opens_offline(self):
        name, raw = run(design_export.export(self.design_id, "html"))
        self.assertTrue(name.endswith(".zip"))
        archive = zipfile.ZipFile(io.BytesIO(raw))
        files = set(archive.namelist())
        for expected in ("index.html", "design.json", "welcome.html", "pick-a-habit.html", "reminders.html",
                         "fonts/kairos/Jost-Variable.woff2"):
            self.assertIn(expected, files)
        page = archive.read("welcome.html").decode()
        self.assertNotIn(design_render.VIEWER_SCRIPT, page)
        self.assertIn("location.href = board + '.html'", page)
        self.assertIn('url("fonts/kairos/Jost-Variable.woff2")', page)
        self.assertNotIn("chat_ids", archive.read("design.json").decode())
        self.assertTrue(any(v["exported"] for v in design_store.versions(self.design_id)))

    def test_rendered_formats_say_they_need_the_desktop_app(self):
        with self.assertRaises(design_render_bridge.Unavailable):
            run(design_export.export(self.design_id, "pdf"))
        self.assertIn("Not run:", text(call("design_export", {"format": "pptx"}, ctx(self.sid))))

    def test_png_pdf_and_pptx_through_a_simulated_render_worker(self):
        """SIMULATED worker on the REAL job stream: jobs are read from
        worker_stream() exactly as Electron reads them, and answered with
        complete() as its POST does."""
        async def scenario():
            stream = design_render_bridge.worker_stream()
            self.assertEqual(await stream.__anext__(), ": connected\n\n")
            self.assertTrue(design_render_bridge.available())
            seen = []

            async def worker():
                while True:
                    block = await stream.__anext__()
                    if not block.startswith("data: "):
                        continue
                    job = json.loads(block[6:])
                    seen.append(job)
                    self.assertRegex(job["path"], r"^/api/designs/[a-f0-9]{12}/boards/[a-z0-9-]+/render\?rt=\d{10}\.[A-Za-z0-9_-]{24}$")
                    slug = job["path"].split("/boards/")[1].split("/")[0]
                    self.assertTrue(design_render.verify(self.design_id, slug, job["path"].split("rt=")[1]))
                    design_render_bridge.complete(job["id"], _png() if job["kind"] == "png" else _pdf())
            task = asyncio.ensure_future(worker())
            try:
                pdf_name, pdf = await design_export.export(self.design_id, "pdf")
                pptx_name, deck = await design_export.export(self.design_id, "pptx")
                png_name, pngs = await design_export.export(self.design_id, "png", ["welcome"])
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                await stream.aclose()
            return seen, (pdf_name, pdf), (pptx_name, deck), (png_name, pngs)
        seen, (pdf_name, pdf), (pptx_name, deck), (png_name, png) = run(scenario())
        self.assertFalse(design_render_bridge.available())
        import pypdfium2 as pdfium
        self.assertEqual(len(pdfium.PdfDocument(pdf)), 3, "every board present")
        from pptx import Presentation
        slides = Presentation(io.BytesIO(deck)).slides
        self.assertEqual([s.shapes.title.text for s in slides], ["Welcome", "Pick a habit", "Reminders"])
        self.assertTrue(all(any(sh.shape_type == 13 for sh in s.shapes) for s in slides), "picture slides")
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual({j["kind"] for j in seen}, {"png", "pdf"})

    def test_the_render_worker_routes_need_the_token(self):
        app = FastAPI(); app.include_router(design_routes.render_router)
        client = TestClient(app)
        self.assertEqual(client.post("/api/design-render/result/x").status_code, 404)
        with patch.object(design_render_bridge, "TOKEN", "secret-token"):
            self.assertEqual(client.post("/api/design-render/result/x", headers={"X-Kairos-Render-Token": "wrong"}).status_code, 404)
            ok = TestClient(app, client=("127.0.0.1", 1)).post("/api/design-render/result/x", headers={"X-Kairos-Render-Token": "secret-token"})
            self.assertEqual(ok.json(), {"ok": False})
            remote = TestClient(app, client=("10.0.0.9", 1)).post("/api/design-render/result/x", headers={"X-Kairos-Render-Token": "secret-token"})
            self.assertEqual(remote.status_code, 404, "loopback only")


class RouteTests(unittest.TestCase):
    """The people-facing routes: a design is reachable only by its owner (or
    an admin), direct edits are versions by You, undo steps back over them,
    and Build in Forge links the new Forge session to the design."""

    def setUp(self):
        app = FastAPI()
        app.include_router(design_routes.router)
        app.include_router(design_routes.systems_router)
        self.client = TestClient(app)

    def test_create_edit_undo_and_link(self):
        created = self.client.post("/api/designs", json={"title": "Blank"}).json()
        design_id = created["id"]
        self.assertEqual(list(created["boards"]), ["screen-1"])
        h1 = _first(design_id, "screen-1", "h1")
        edited = self.client.post(f"/api/designs/{design_id}/boards/screen-1/text", json={"id": h1, "text": "Hello"}).json()
        self.assertEqual(edited["changed"], {"screen-1": [h1]})
        self.assertEqual(design_store.versions(design_id)[0]["by"], "You")
        self.client.post(f"/api/designs/{design_id}/board-action", json={"action": "move", "board": "screen-1", "x": 300, "y": 10})
        self.assertEqual(design_store.manifest(design_id)["boards"]["screen-1"]["x"], 300)
        self.assertEqual(self.client.post(f"/api/designs/{design_id}/undo").status_code, 200)
        self.assertEqual(design_store.manifest(design_id)["boards"]["screen-1"]["x"], 0)
        tokens = self.client.post(f"/api/designs/{design_id}/tokens", json={"set": {"--ds-accent": "#123456"}}).json()
        self.assertEqual(tokens["system"]["variables"]["--ds-accent"], "#123456")
        sid = new_chat()
        self.assertIn(sid, self.client.post(f"/api/designs/{design_id}/link", json={"session_id": sid}).json()["chat_ids"])
        listed = self.client.get(f"/api/designs?chat={sid}").json()
        self.assertEqual([d["id"] for d in listed], [design_id])
        with patch.object(design_routes.auth_manager, "is_admin", return_value=False):
            app = FastAPI(); app.include_router(design_routes.router)
            app.dependency_overrides[design_routes.require_user] = lambda: "someone-else"
            other = TestClient(app)
            self.assertEqual(other.get(f"/api/designs/{design_id}").status_code, 404)
            self.assertEqual(other.get("/api/designs").json(), [])

    def test_build_in_forge_links_the_session(self):
        design_id = self.client.post("/api/designs", json={"title": "App"}).json()["id"]
        sid = new_chat("forge")
        seen = {}

        def create(project_id, task, *args):
            seen.update(project_id=project_id, task=task)
            return {"id": sid}
        from services import forge_sessions
        with patch.object(forge_sessions.forge_sessions, "create", create):
            app = FastAPI(); app.include_router(design_routes.router)
            app.dependency_overrides[design_routes.require_admin] = lambda: "local"
            result = TestClient(app).post(f"/api/designs/{design_id}/forge", json={"project_id": "abcdefabcdef"}).json()
        self.assertEqual(result["session_id"], sid)
        self.assertIn(f"design id {design_id}", seen["task"])
        self.assertIn("design_read", seen["task"])
        self.assertIn("which file implements which board", seen["task"])
        self.assertIn(sid, design_store.manifest(design_id)["chat_ids"], "the Forge session can read the design")
        self.assertIn("Design ", text(call("design_outline", {}, ctx(sid, tool_registry.CODEX), tool_registry.CODEX)))

    def test_design_systems_routes(self):
        app = FastAPI(); app.include_router(design_routes.systems_router)
        app.dependency_overrides[design_routes.require_admin] = lambda: "local"
        client = TestClient(app)
        made = client.post("/api/design-systems", json={"name": "Pasted", "css": ":root{--primary:#225588;--bg:#ffffff;--text:#111111}"}).json()
        self.assertEqual(design_systems.variables(made["tokens"])["--ds-accent"], "#225588")
        self.assertIn(made["id"], [s["id"] for s in client.get("/api/design-systems").json()])
        self.assertEqual(client.delete("/api/design-systems/kairos").status_code, 422)


class RoutingTests(unittest.TestCase):
    """A design request reaches the canvas on every model (live check 2026-10-22:
    Claude built an HTML file instead, never seeing design_create)."""

    def test_every_chat_model_is_told_to_use_the_canvas(self):
        from core import system_prompt
        line = "To design screens, pages or slides, use the Design canvas: design_create, then design_edit by id."
        for name, prompt in (("claude", system_prompt.for_claude()), ("external", system_prompt.for_external()),
                             ("codex", system_prompt.for_codex("py", "cli.py"))):
            self.assertIn(line, prompt, name)
        self.assertNotIn(line, system_prompt.HELPER_PROMPT, "helpers cannot write")

    def test_tool_search_finds_design_create(self):
        from core import tool_search
        catalog = tool_registry.deferred_tools(True, session_id=new_chat())
        for query in ("design", "screens", "onboarding", "mockup", "design an onboarding flow", "landing page mockup"):
            hits = json.loads(tool_search.search(catalog, query, 5))
            self.assertEqual(hits[0]["name"], "design_create", query)
        self.assertEqual(json.loads(tool_search.search(catalog, "create task", 3))[0]["name"], "create_task")
        # Claude Code searches the MCP tool's own name and description.
        spec = next(s for s in tool_registry.specs(tool_registry.CLAUDE, True) if s.name == "design_create")
        for word in ("Design screens", "mockup", "wireframe", "onboarding", "landing page", "slides"):
            self.assertIn(word, spec.description)

    def test_overriding_many_tokens_gets_a_brand_note(self):
        sid = new_chat()
        create(sid, boards=[{"title": "One", "frame": "phone"}])
        few = text(call("design_tokens", {"set": {"--ds-accent": "#225588"}}, ctx(sid)))
        self.assertNotIn("Keep the system's look", few)
        many = text(call("design_tokens", {"set": {"--ds-bg": "#101418", "--ds-text": "#F2F4F8", "--ds-surface": "#1B2026",
                                                    "--ds-accent": "#55AA88"}}, ctx(sid)))
        self.assertIn("overrode 4 of the design system's tokens", many)
        self.assertIn("unless the person asked for a different look", many)
        spec = next(s for s in tool_registry.specs(tool_registry.OPENAI, True) if s.name == "design_tokens")
        self.assertIn("unless the person asks for a different look or palette", spec.description)
        skill = (REPO / "skill_templates" / "design-canvas" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Keep the design system's look", skill)


class ElectronWorkerTests(unittest.TestCase):
    def test_the_worker_accepts_only_board_routes(self):
        source = (REPO / "electron" / "designRender.js").read_text(encoding="utf-8")
        for needed in ("persist:design-render", "setPermissionRequestHandler", "will-download", "setWindowOpenHandler",
                       "will-navigate", "onBeforeRequest", "offscreen: true", "sandbox: true", "printToPDF", "capturePage"):
            self.assertIn(needed, source)
        self.assertNotIn("preload", source.split("webPreferences")[1].split("}")[0])
        main = (REPO / "electron" / "main.js").read_text(encoding="utf-8")
        self.assertIn("KAIROS_RENDER_TOKEN: RENDER_TOKEN", main)
        self.assertIn("designRender.start({ backendUrl: BACKEND_URL, token: RENDER_TOKEN })", main)


def tearDownModule():
    # Windows will not delete a database that is still open.
    from core import session_manager_store
    session_manager_store.close()
    shutil.rmtree(environment)


if __name__ == "__main__":
    unittest.main(verbosity=1)
