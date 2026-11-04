"""Part 2, group g5, area A09: Library Designs gaps not covered by
test_design_canvas.py, with no model, browser or Electron.

- stale targets and concurrent edits cannot corrupt a design;
- hostile or malformed HTML through the direct-edit routes;
- restore / duplicate keep assets and tokens; delete leaves other designs alone;
- exports are INSPECTED (zip contents and offline link integrity, render job
  dimensions, PPTX picture geometry, PDF page count and size), and a missing
  render worker is an explicit 503 naming the desktop app;
- efficiency numbers (printed): targeted vs whole-board edit size, design tool
  schema size, version growth, 60-board create/list/render/export times.

Tests named test_BUG_* assert the CORRECT behaviour and currently FAIL on dev.

Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g5_design_gaps.py
"""
import io
import json
import re
import sys
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_design_canvas as base  # noqa: E402  (sets JARVIS_DATA_DIR and the shared helpers)
from test_design_canvas import (ONBOARDING, _first, _pdf, _png, button_id, call, create, ctx, new_chat,  # noqa: E402
                                run, text, tearDownModule)  # noqa: F401  (tearDownModule cleans the data dir)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import design_export, design_html, design_render, design_render_bridge, design_store, tool_registry  # noqa: E402
from routes import design_routes  # noqa: E402

BENCH = {}


def ms(start):
    return round((time.perf_counter() - start) * 1000, 1)


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * q))]


def client():
    app = FastAPI()
    app.include_router(design_routes.router)
    return TestClient(app)


class EditSafetyTests(unittest.TestCase):
    def setUp(self):
        self.client = client()
        self.sid = new_chat()
        self.design_id, _ = create(self.sid)

    def ops(self, slug, ops):
        return self.client.post(f"/api/designs/{self.design_id}/boards/{slug}/ops", json={"ops": ops})

    def test_a_stale_element_or_board_is_refused_and_makes_no_version(self):
        h1 = _first(self.design_id, "welcome", "h1")
        before = design_store.manifest(self.design_id)["version"]
        self.assertEqual(self.ops("welcome", [{"op": "remove", "id": h1}]).status_code, 200)
        v = design_store.manifest(self.design_id)["version"]
        self.assertEqual(v, before + 1)
        stale = self.client.post(f"/api/designs/{self.design_id}/boards/welcome/text", json={"id": h1, "text": "late"})
        self.assertEqual(stale.status_code, 422, stale.text)
        self.assertIn("Nothing was changed", stale.text)
        self.assertIn(self.ops("ghost-board", [{"op": "remove", "id": h1}]).status_code, (404, 422))
        self.assertEqual(design_store.manifest(self.design_id)["version"], v, "refused edits write no version")
        self.assertEqual(self.client.post(f"/api/designs/{'0' * 12}/boards/welcome/text", json={"id": h1, "text": "x"}).status_code, 404)

    def test_a_batch_with_one_bad_operation_changes_nothing(self):
        html_before = design_store.board_html(self.design_id, "welcome")
        button = button_id(self.design_id, "welcome")
        r = self.ops("welcome", [{"op": "set_text", "id": button, "text": "Changed"}, {"op": "remove", "id": "zz99"}])
        self.assertEqual(r.status_code, 422)
        self.assertEqual(design_store.board_html(self.design_id, "welcome"), html_before)

    def test_hostile_and_malformed_html_is_cleaned_not_stored(self):
        main = _first(self.design_id, "welcome", "main")
        evil = ('<script>alert(1)</script><img src="http://evil.test/x.png" onerror="alert(2)">'
                '<a href="javascript:alert(3)">x</a><iframe src="http://evil.test"></iframe>'
                '<div style="background:url(http://evil.test/a.png)"><p>unclosed<b>bold')
        r = self.ops("welcome", [{"op": "insert", "ref_id": main, "position": "last_child", "html": evil}])
        stored = design_store.board_html(self.design_id, "welcome")
        for needle in ("<script>alert", "onerror", "javascript:", "<iframe", "evil.test"):
            self.assertNotIn(needle, stored, f"{needle} survived (HTTP {r.status_code})")
        design_html.parse(stored)  # still parses
        self.assertIn("unclosed", stored)

    def test_oversized_replacement_is_refused_and_the_board_survives(self):
        main = _first(self.design_id, "welcome", "main")
        before = design_store.board_html(self.design_id, "welcome")
        r = self.ops("welcome", [{"op": "replace", "id": main, "html": "<p>" + "x" * (3 * 1024 * 1024) + "</p>"}])
        self.assertGreaterEqual(r.status_code, 400)
        self.assertEqual(design_store.board_html(self.design_id, "welcome"), before)

    def test_concurrent_edits_to_one_board_all_land_and_the_history_is_whole(self):
        lis = [n.kd for n in design_html.parse(design_store.board_html(self.design_id, "pick-a-habit")).elements() if n.tag == "li"]
        self.assertEqual(len(lis), 3)
        start = design_store.manifest(self.design_id)["version"]
        errors, results = [], []

        def worker(i):
            try:
                c = client()
                for k in range(8):
                    r = c.post(f"/api/designs/{self.design_id}/boards/pick-a-habit/text",
                               json={"id": lis[i % 3], "text": f"t{i}-{k}"})
                    results.append(r.status_code)
            except Exception as error:  # pragma: no cover
                errors.append(error)
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        changed = results.count(200)
        data = design_store.manifest(self.design_id)
        self.assertEqual(data["version"], start + changed, "one version per accepted edit, none lost or doubled")
        numbers = sorted(v["n"] for v in design_store.versions(self.design_id))
        self.assertEqual(numbers, list(range(1, data["version"] + 1)))
        design_html.parse(design_store.board_html(self.design_id, "pick-a-habit"))
        for n in numbers:
            self.assertIsNotNone(design_store.board_at(self.design_id, "pick-a-habit", n), f"v{n} rebuilds")


class VersionsAssetsTokensTests(unittest.TestCase):
    def setUp(self):
        self.client = client()
        self.sid = new_chat()
        self.design_id, _ = create(self.sid)
        self.asset = design_store.add_asset(self.design_id, _png(), "png")

    def test_restore_brings_back_tokens_of_that_version_and_keeps_every_asset(self):
        main = _first(self.design_id, "welcome", "main")
        self.client.post(f"/api/designs/{self.design_id}/boards/welcome/ops", json={"ops": [
            {"op": "insert", "ref_id": main, "position": "last_child", "html": f'<img src="{self.asset}" alt="pic">'}]})
        with_image = design_store.manifest(self.design_id)["version"]
        self.client.post(f"/api/designs/{self.design_id}/tokens", json={"set": {"--ds-accent": "#123456"}})
        self.assertEqual(design_store.manifest(self.design_id)["token_overrides"].get("--ds-accent"), "#123456")
        self.client.post(f"/api/designs/{self.design_id}/versions/{with_image}/name", json={"name": "With picture"})
        restored = self.client.post(f"/api/designs/{self.design_id}/versions/{with_image}/restore").json()
        self.assertEqual(restored["version"], with_image + 2)
        self.assertNotIn("--ds-accent", design_store.manifest(self.design_id)["token_overrides"])
        self.assertTrue(design_store.asset_path(self.design_id, self.asset.rsplit("/", 1)[-1]).is_file())
        self.assertIn("pic", design_store.board_html(self.design_id, "welcome"))
        back = self.client.post(f"/api/designs/{self.design_id}/versions/{with_image + 1}/restore").json()
        self.assertEqual(design_store.manifest(self.design_id)["token_overrides"].get("--ds-accent"), "#123456")
        self.assertTrue(any(v["name"] == "With picture" for v in design_store.versions(self.design_id)), "a named version stays named")
        self.assertEqual(self.client.post(f"/api/designs/{self.design_id}/versions/999/restore").status_code, 404)
        self.assertEqual(back["version"], with_image + 3)

    def test_duplicate_and_delete_are_independent(self):
        self.client.post(f"/api/designs/{self.design_id}/tokens", json={"set": {"--ds-accent": "#abcdef"}})
        copy = self.client.post(f"/api/designs/{self.design_id}/duplicate", json={}).json()
        self.assertTrue(copy["title"].endswith("(copy)"))
        self.assertNotEqual(copy["id"], self.design_id)
        self.assertEqual(design_store.manifest(copy["id"])["token_overrides"].get("--ds-accent"), "#abcdef")
        self.assertTrue(design_store.asset_path(copy["id"], self.asset.rsplit("/", 1)[-1]).is_file(), "assets are copied")
        self.assertEqual(self.client.post(f"/api/designs/{self.design_id}/duplicate", json={"version": 999}).status_code, 404)
        older = self.client.post(f"/api/designs/{self.design_id}/duplicate", json={"version": 1}).json()
        self.assertEqual(design_store.manifest(older["id"])["token_overrides"], {}, "a copy of v1 has v1's tokens")
        self.assertEqual(self.client.delete(f"/api/designs/{self.design_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/designs/{self.design_id}").status_code, 404)
        self.assertTrue(design_store.asset_path(copy["id"], self.asset.rsplit("/", 1)[-1]).is_file(), "the copy keeps its own assets")
        self.assertEqual(self.client.get(f"/api/designs/{copy['id']}").status_code, 200)
        self.assertNotIn(self.design_id, [d["id"] for d in self.client.get("/api/designs").json()])

    def test_rename_validates_and_is_a_version(self):
        before = design_store.manifest(self.design_id)["version"]
        r = self.client.patch(f"/api/designs/{self.design_id}", json={"title": "Better name"})
        self.assertEqual((r.status_code, r.json()["title"]), (200, "Better name"))
        self.assertEqual(design_store.manifest(self.design_id)["version"], before + 1)
        self.assertEqual(self.client.patch(f"/api/designs/{self.design_id}", json={"title": "x" * 121}).status_code, 422)
        self.assertGreaterEqual(self.client.patch(f"/api/designs/{self.design_id}", json={"title": "   "}).status_code, 400)
        self.assertEqual(design_store.manifest(self.design_id)["title"], "Better name")


class ExportInspectionTests(unittest.TestCase):
    def setUp(self):
        self.client = client()
        self.sid = new_chat()
        self.design_id, _ = create(self.sid)
        self.asset = design_store.add_asset(self.design_id, _png(), "png")
        main = _first(self.design_id, "welcome", "main")
        self.client.post(f"/api/designs/{self.design_id}/boards/welcome/ops", json={"ops": [
            {"op": "insert", "ref_id": main, "position": "last_child", "html": f'<img src="{self.asset}" alt="pic">'}]})

    def zip(self, boards=None):
        r = self.client.post(f"/api/designs/{self.design_id}/export", json={"format": "html", **({"boards": boards} if boards else {})})
        self.assertEqual(r.status_code, 200, r.text)
        name, raw, _ = run(design_export.export(self.design_id, "html", boards))
        return name, zipfile.ZipFile(io.BytesIO(raw)), r.json()

    def test_every_local_reference_in_the_zip_resolves_inside_the_zip(self):
        _, archive, body = self.zip()
        files = set(archive.namelist())
        self.assertEqual(body["size"], len(run(design_export.export(self.design_id, "html"))[1]))
        missing = []
        for name in files:
            if not name.endswith(".html"):
                continue
            page = archive.read(name).decode()
            for ref in re.findall(r'(?:src|href)="([^"#]+)"', page) + re.findall(r'url\("([^")]+)"\)', page):
                if re.match(r"^(https?:|data:|mailto:|//)", ref):
                    self.fail(f"{name} reaches outside the zip: {ref}")
                if ref not in files:
                    missing.append((name, ref))
        self.assertEqual(missing, [])
        self.assertIn(f"assets/{self.asset.rsplit('/', 1)[-1]}", files, "the uploaded picture is in the zip")
        self.assertEqual(archive.testzip(), None)

    def test_BUG_a_partial_zip_design_json_lists_only_exported_boards(self):
        _, archive, _ = self.zip(["welcome"])
        listed = set(json.loads(archive.read("design.json"))["boards"])
        self.assertEqual(listed, {"welcome"}, "design.json still lists every board's title and size")

    def test_BUG_a_partial_zip_has_no_dead_links(self):
        """Exporting only some boards: the picked boards' data-kd-goto links to
        boards that are not in the zip become dead pages."""
        _, archive, _ = self.zip(["welcome"])
        files = set(archive.namelist())
        self.assertIn("welcome.html", files)
        self.assertNotIn("reminders.html", files)
        page = archive.read("welcome.html").decode()
        targets = set(re.findall(r'data-kd-goto="([a-z0-9-]+)"', page))
        self.assertTrue(targets <= {s[:-5] for s in files if s.endswith(".html")} | {"back"},
                        f"welcome.html links to {sorted(targets)} but the zip holds {sorted(files)}")

    def test_render_jobs_carry_each_boards_dimensions_and_pptx_keeps_their_ratio(self):
        jobs = []

        async def fake(design_id, slug, kind="png", *, scale=1, version=None, hide=None):
            meta = design_store.manifest(design_id)["boards"][slug]
            jobs.append((slug, kind, scale, meta["w"], meta["h"]))
            return _png(meta["w"] // 10, meta["h"] // 10) if kind == "png" else _pdf()
        design_store.change(self.design_id, lambda d, f: (None, "x"), by="t", tool="t")  # no-op
        self.client.post(f"/api/designs/{self.design_id}/board-action", json={"action": "add", "title": "Deck", "format": "slide"})
        with patch.object(design_render_bridge, "render", fake), patch.object(design_render_bridge, "available", lambda: True):
            _, deck, _ = run(design_export.export(self.design_id, "pptx", pptx_mode="pictures"))
            _, png, _ = run(design_export.export(self.design_id, "png", ["pick-a-habit"]))
            _, pdf, _ = run(design_export.export(self.design_id, "pdf", ["welcome", "reminders"]))
        from pptx import Presentation
        presentation = Presentation(io.BytesIO(deck))
        data = design_store.manifest(self.design_id)
        order = [s for s, _ in design_store.ordered_boards(data)]
        self.assertEqual(len(presentation.slides), len(order))
        for slide, slug in zip(presentation.slides, order):
            meta = data["boards"][slug]
            picture = next(sh for sh in slide.shapes if sh.shape_type == 13)
            self.assertAlmostEqual(picture.width / picture.height, meta["w"] / meta["h"], delta=0.02, msg=slug)
            if meta["frame"] == "slide":
                self.assertEqual((picture.left, picture.top), (0, 0), "a slide board is full bleed")
            else:
                self.assertGreaterEqual(picture.left, 0)
                self.assertLessEqual(picture.left + picture.width, presentation.slide_width)
                self.assertLessEqual(picture.top + picture.height, presentation.slide_height)
        self.assertEqual({j[2] for j in jobs if j[1] == "png" and j[0] == "pick-a-habit"}, {2}, "PNGs are rendered at 2x")
        self.assertTrue(png.startswith(b"\x89PNG") and len(png) > 100)
        import pypdfium2 as pdfium
        self.assertEqual(len(pdfium.PdfDocument(pdf)), 2, "only the picked boards")
        self.assertEqual([j[0] for j in jobs if j[1] == "pdf"], ["welcome", "reminders"], "in the order asked")

    def test_a_missing_render_worker_is_an_explicit_503_and_html_still_works(self):
        self.assertFalse(design_render_bridge.available())
        for fmt in ("png", "pdf", "pptx"):
            r = self.client.post(f"/api/designs/{self.design_id}/export", json={"format": fmt})
            self.assertEqual(r.status_code, 503, fmt)
            self.assertIn("desktop app", r.json()["detail"])
        status = self.client.get("/api/designs/render-status").json()
        self.assertEqual(status["available"], False)
        self.assertIn("desktop app", status["message"])
        self.assertEqual(self.client.post(f"/api/designs/{self.design_id}/export", json={"format": "html"}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/designs/{self.design_id}/export", json={"format": "docx"}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/designs/{self.design_id}/export", json={"format": "html", "boards": ["nope"]}).status_code, 404)

    def test_a_worker_that_returns_garbage_or_an_error_is_reported(self):
        async def scenario(result, error=None):
            stream = design_render_bridge.worker_stream()
            await stream.__anext__()

            async def worker():
                while True:
                    block = await stream.__anext__()
                    if block.startswith("data: "):
                        design_render_bridge.complete(json.loads(block[6:])["id"], result, error)
            import asyncio
            task = asyncio.ensure_future(worker())
            try:
                return await design_export.export(self.design_id, "png", ["welcome"])
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                await stream.aclose()
        with patch.object(design_render_bridge, "_queue", None), patch.object(design_render_bridge, "_loop", None):
            with self.assertRaisesRegex(RuntimeError, "other than a PNG"):
                run(scenario(b"<html>not a png"))
        with patch.object(design_render_bridge, "_queue", None), patch.object(design_render_bridge, "_loop", None):
            with self.assertRaisesRegex(RuntimeError, "window blew up"):
                run(scenario(b"", "window blew up"))


class EfficiencyTests(unittest.TestCase):
    def test_targeted_edit_vs_whole_board_and_tool_schema_size(self):
        sid = new_chat()
        design_id, created = create(sid)
        c = ctx(sid)
        button = button_id(design_id, "pick-a-habit")
        board = design_store.board_html(design_id, "pick-a-habit")
        targeted_args = {"board": "2", "ops": [{"op": "set_style", "id": button, "style": {"width": "100%"}}]}
        targeted = text(call("design_edit", targeted_args, c))
        main = _first(design_id, "pick-a-habit", "main")
        whole_html = board.replace("60%", "100%")
        whole_args = {"board": "2", "ops": [{"op": "replace", "id": main, "html": whole_html}]}
        whole = text(call("design_edit", whole_args, c))
        schema = [t for t in tool_registry.openai_tools(True, session_id=sid) if t["function"]["name"].startswith("design_")]
        schema_bytes = len(json.dumps(schema))
        read = text(call("design_read", {"board": "2"}, c))
        outline = text(call("design_outline", {}, c))
        tokens = lambda s: round(len(s) / 4)
        BENCH["targeted_vs_whole_board_edit"] = {
            "targeted_args+result_chars": len(json.dumps(targeted_args)) + len(targeted),
            "whole_board_args+result_chars": len(json.dumps(whole_args)) + len(whole),
            "targeted_est_tokens": tokens(json.dumps(targeted_args) + targeted),
            "whole_est_tokens": tokens(json.dumps(whole_args) + whole),
            "design_read_one_board_chars": len(read), "design_outline_3_boards_chars": len(outline),
            "design_create_result_chars": len(created),
            "design_tools_listed": len(schema), "design_tool_schema_chars": schema_bytes,
            "design_tool_schema_est_tokens": tokens(json.dumps(schema)),
        }
        self.assertLess(len(json.dumps(targeted_args)) + len(targeted), 0.6 * (len(json.dumps(whole_args)) + len(whole)),
                        "a targeted edit costs clearly less than resending the board")
        self.assertLess(len(targeted), 600, "the edit result is a short confirmation, not the board")

    def test_version_growth_per_edit_on_60_boards_and_big_canvas_timings(self):
        sid = new_chat()
        boards = [{"title": f"Screen {n}", "frame": "phone",
                   "html": f'<main><h1>Screen {n}</h1>' + "".join(f"<p>row {k} lorem ipsum dolor sit amet</p>" for k in range(60)) + '</main>'}
                  for n in range(60)]
        t = time.perf_counter()
        design_id, _ = create(sid, boards=boards[:12])
        for extra in boards[12:]:
            text(call("design_add_board", {"title": extra["title"], "frame": "phone", "html": extra["html"]}, ctx(sid)))
        create_ms = ms(t)
        folder = design_store._folder(design_id)
        size = lambda: sum(f.stat().st_size for f in (folder / "versions").rglob("*") if f.is_file())
        before = size()
        h1 = _first(design_id, "screen-7", "h1")
        edit_times = []
        for n in range(25):
            t = time.perf_counter()
            text(call("design_edit", {"board": "screen-7", "ops": [{"op": "set_text", "id": h1, "text": f"Edit {n}"}]}, ctx(sid)))
            edit_times.append(ms(t))
        per_edit = (size() - before) / 25
        entry_bytes = (folder / "versions" / "30.json").stat().st_size if (folder / "versions" / "30.json").exists() else 0
        api = client()
        listing, render_t, thumb_t = [], [], []
        for _ in range(10):
            t = time.perf_counter(); api.get("/api/designs"); listing.append(ms(t))
            t = time.perf_counter(); api.get(f"/api/designs/{design_id}"); render_t.append(ms(t))
        t = time.perf_counter(); zipped = design_export.html_zip(design_id); zip_ms = ms(t)
        board_render = []
        for n in range(10):
            t = time.perf_counter(); design_render.render_document(design_id, "screen-7", viewer=True); board_render.append(ms(t))
        BENCH["design_60_boards"] = {
            "create_ms": create_ms, "edit_p50_ms": pct(edit_times, .5), "edit_p95_ms": pct(edit_times, .95),
            "history_bytes_per_one_text_edit": round(per_edit), "version_json_bytes": entry_bytes,
            "board_html_bytes": len(design_store.board_html(design_id, "screen-7")),
            "GET_/api/designs_p50_ms": pct(listing, .5), "GET_design_p50_ms": pct(render_t, .5),
            "GET_design_p95_ms": pct(render_t, .95), "html_zip_ms": zip_ms, "html_zip_bytes": len(zipped),
            "board_render_document_p50_ms": pct(board_render, .5)}
        # One text edit should not cost more than its board plus a small record.
        self.assertLess(per_edit, 30000,
                        f"EFFICIENCY: a one-line edit grows history by {round(per_edit)} bytes")

    def test_a_list_of_designs_reads_each_manifest_once(self):
        sid = new_chat()
        ids = [create(sid)[0] for _ in range(12)]
        reads = {"n": 0}
        real = design_store.manifest

        def counting(design_id):
            reads["n"] += 1
            return real(design_id)
        with patch.object(design_store, "manifest", counting):
            client().get("/api/designs")
        total = len(design_store.list_designs())
        BENCH["list_designs_manifest_reads_per_request"] = {"designs": total, "manifest()_calls": reads["n"]}
        self.assertLessEqual(reads["n"], total * 2, "EFFICIENCY: more than two manifest reads per design for one listing")
        self.assertTrue(ids)


def _print_bench(*_):
    print("\nBENCH", json.dumps(BENCH, indent=1))


unittest.addModuleCleanup(_print_bench)

if __name__ == "__main__":
    unittest.main(verbosity=1)
