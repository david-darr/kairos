"""Documents, charts and editable Office exports (Creative Output Quality spec, Phase 2).

What these prove, with no model or browser started (the render worker is
SIMULATED on the real job stream, as in test_design_canvas.py; the real
Electron worker was checked by hand in the Phase 2 build notes):

- the `document` format: Letter and A4, as wide as its page, growing; the
  words people use for it reach it; a one-page print stays `print`;
- a document prints on real pages: page size, margins, running header, page
  numbers, repeated table headers; the header text can't break out of CSS;
  every other board still prints as one page its own size;
- charts drawn from tables on every save: numbers as people write them, the
  drawing replaced (never stacked), the table kept and hidden, stat as text,
  a figure without a table explained, the Word picture drawn without a browser;
- the new checks: the document type floor, one idea per slide (hidden chart
  tables not counted), mostly blank printed pages;
- the editable PowerPoint: what becomes a text box, shape, picture or chart,
  and what stays in the background picture (and why); the deck through the
  job stream, Office fonts or design fonts, the overflow estimate and its
  shrink-to-fit, exact picture slides on request;
- Word from a document board: real heading styles in the look's fonts, the
  table header repeating, a chart picture, the page header and numbers, and a
  clear refusal for a design with no document board;
- the tool, routes, render jobs, skills and prompt say all of it.

Run: .venv\\Scripts\\python.exe scripts\\test_design_documents.py
"""
import asyncio
import io
import json
import re
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_design_canvas as base  # noqa: E402  (sets JARVIS_DATA_DIR and the shared helpers)
from test_design_canvas import _png, call, ctx, new_chat, run, text, tearDownModule  # noqa: E402,F401

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import (design_charts, design_checks, design_docx, design_export, design_formats, design_html,  # noqa: E402
                  design_pptx, design_render, design_render_bridge, design_store, design_systems, tool_registry)
from routes import design_routes  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
BAR = ('<figure data-chart="bar"><figcaption>Signups</figcaption><table><thead><tr><th>Month</th><th>Signups</th>'
       '<th>Churn</th></tr></thead><tbody><tr><td>Jan</td><td>1,200</td><td>80</td></tr><tr><td>Feb</td><td>1.5k</td>'
       '<td>95</td></tr><tr><td>Mar</td><td>$2.1k</td><td>70</td></tr></tbody></table></figure>')
GUIDE = ('<h1 style="font-family: var(--ds-font-display)">Coaching guide</h1><h2>Week 1</h2><p>Players work in pairs.</p>'
         '<ul><li>Cones</li><li>Bibs</li></ul><table><thead><tr><th>Drill</th><th>Time</th></tr></thead><tbody>'
         '<tr><td>Pairs</td><td>10 min</td></tr></tbody></table>' + BAR + '<blockquote>Shin guards on.</blockquote>')


def make(boards, look="fintech-mint", title="Phase 2 test"):
    sid = new_chat()
    result = text(call("design_create", {"title": title, "look": look, "boards": boards}, ctx(sid)))
    match = re.search(r"Created design ([a-f0-9]{12})", result)
    assert match, result
    return match.group(1), result


def client():
    app = FastAPI()
    app.include_router(design_routes.router)
    return TestClient(app)


async def with_worker(answer, scenario):
    """The SIMULATED render worker on the real job stream: `answer(job)` gives each job's bytes."""
    stream = design_render_bridge.worker_stream()
    await stream.__anext__()
    jobs = []

    async def worker():
        while True:
            block = await stream.__anext__()
            if block.startswith("data: "):
                job = json.loads(block[6:])
                jobs.append(job)
                design_render_bridge.complete(job["id"], answer(job))
    task = asyncio.ensure_future(worker())
    try:
        return await scenario(), jobs
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await stream.aclose()


def isolated(coro):
    with patch.object(design_render_bridge, "_queue", None), patch.object(design_render_bridge, "_loop", None):
        return run(coro)


class DocumentFormatTests(unittest.TestCase):
    def test_letter_and_a4_pages_that_grow(self):
        letter, = design_formats.resolve("document")
        a4, = design_formats.resolve("document", size="a4")
        self.assertEqual((letter["w"], letter["h"], letter["grow"]), (816, 1056, True))
        self.assertEqual((a4["w"], a4["h"]), (794, 1123))
        self.assertTrue(design_formats.paged(letter) and design_formats.grows(letter))
        self.assertEqual(design_formats.page(a4), ("A4", 794, 1123))
        self.assertFalse(design_formats.paged(design_formats.resolve("print", orientation="portrait")[0]))

    def test_the_words_people_use_reach_it(self):
        for word in ("report", "pdf", "guide", "proposal", "handout", "worksheet", "document"):
            self.assertEqual(design_formats.resolve(word)[0]["format"], "document", word)
        self.assertEqual(design_formats.resolve("letter", orientation="portrait")[0]["format"], "print",
                         "one printed page stays print")
        self.assertIn("document (", design_formats.catalog_text())

    def test_a_document_prints_on_real_pages(self):
        design_id, reply = make([{"title": "Guide", "format": "document", "orientation": "portrait", "html": GUIDE}],
                                title='Guide "</style><script>x</script>')
        self.assertIn("pages flow", reply)
        page = design_render.render_document(design_id, "guide")
        self.assertIn("@page { size: letter; margin: 72px;", page)
        self.assertIn('counter(page) " of " counter(pages)', page)
        self.assertIn("@page :first { @top-left { content: none; } }", page)
        self.assertIn("thead { display: table-header-group; }", page)
        self.assertIn("@media screen { body { padding: 72px; } }", page)
        self.assertNotIn("</style><script>", page, "the title can't break out of the style block")
        self.assertEqual(page.count("<script>"), 1, "only the viewer script")
        bg = design_systems.variables(design_systems.get("fintech-mint")["tokens"])["--ds-bg"]
        self.assertIn(f"background: {bg};", page, "the page colour reaches the margins")

    def test_every_other_board_prints_as_one_page_its_size(self):
        design_id, _ = make([{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>Hi</h1>"}])
        page = design_render.render_document(design_id, "poster")
        self.assertIn("@page { size: 1200px 1800px; margin: 0; }", page)
        self.assertNotIn("counter(pages)", page)


class ChartTests(unittest.TestCase):
    def test_numbers_as_people_write_them(self):
        for raw, value in (("1,200", 1200), ("1.5k", 1500), ("$2.4M", 2.4e6), ("45%", 45), ("−12", -12), ("n/a", None)):
            self.assertEqual(design_charts.number(raw), value, raw)

    def test_a_table_becomes_a_drawing_in_the_looks_tokens(self):
        stored, root, notes = design_html.normalize(BAR)
        self.assertEqual(notes, [])
        figure = next(n for n in root.elements() if n.tag == "figure")
        spec = design_charts.parse(figure)
        self.assertEqual(spec["categories"], ["Jan", "Feb", "Mar"])
        self.assertEqual(spec["series"], [("Signups", [1200.0, 1500.0, 2100.0]), ("Churn", [80.0, 95.0, 70.0])])
        self.assertIn("var(--ds-accent)", stored)
        self.assertIn('data-kd-chart-out=""', stored)
        self.assertRegex(stored, r"<table[^>]* hidden")
        self.assertIn('role="img"', stored)
        again, _, _ = design_html.normalize(stored)
        self.assertEqual(again.count("<svg"), 1, "a re-save replaces the drawing, never stacks it")

    def test_line_donut_and_stat(self):
        line, _, _ = design_html.normalize(BAR.replace('"bar"', '"line"'))
        self.assertIn("<polyline", line)
        donut, _, _ = design_html.normalize('<figure data-chart="donut"><table><tr><th>Plan</th><th>Share</th></tr>'
                                            '<tr><td>Free</td><td>60</td></tr><tr><td>Pro</td><td>40</td></tr></table></figure>')
        self.assertIn(">60%<", donut, "the centre is the biggest share")
        stat, root, _ = design_html.normalize('<figure data-chart="stat"><table><tr><th>K</th><th>V</th></tr>'
                                              '<tr><td>Paying teams</td><td>$2.4M</td></tr></table></figure>')
        self.assertNotIn("<svg", stat, "big numbers stay text, editable everywhere")
        self.assertIn(">$2.4M<", stat)

    def test_a_figure_without_a_table_is_explained(self):
        _, _, notes = design_html.normalize('<figure data-chart="bar"><p>soon</p></figure>')
        self.assertTrue(any("<table>" in n for n in notes), notes)

    def test_labels_are_escaped(self):
        stored, _, _ = design_html.normalize(BAR.replace("Jan", "<b>x</b>&amp;"))
        self.assertNotIn("<b>x</b>", stored.split("<svg", 1)[1].split("</svg>", 1)[0])

    def test_the_word_picture_needs_no_browser(self):
        _, root, _ = design_html.normalize(BAR)
        spec = design_charts.parse(next(n for n in root.elements() if n.tag == "figure"))
        png = design_charts.png(spec, {"--ds-accent": "#0B5FFF", "--ds-bg": "#FFFFFF"}, width=800)
        self.assertTrue(png.startswith(b"\x89PNG"))


class CheckTests(unittest.TestCase):
    def test_the_document_floor_is_13px(self):
        root = design_html.parse('<p style="font-size: 12px">Small print</p>')
        notes = design_checks.check(root, {"format": "document", "w": 816, "h": 1056}, {})
        self.assertTrue(any("document floor of 13px" in n for n in notes), notes)

    def test_one_idea_per_slide(self):
        words = " ".join(["word"] * 70)
        notes = design_checks.check(design_html.parse(f"<p>{words}</p>"), {"format": "slides", "w": 1920, "h": 1080}, {})
        self.assertTrue(any("one idea" in n for n in notes), notes)
        _, root, _ = design_html.normalize("<h1>Signups tripled</h1>" + BAR)
        self.assertFalse(any("one idea" in n for n in design_checks.check(root, {"format": "slides", "w": 1920, "h": 1080}, {})),
                         "a chart's hidden table and drawing are not words on the slide")

    def test_mostly_blank_printed_pages(self):
        folder = base.environment / "pages-check"
        folder.mkdir(exist_ok=True)
        from PIL import Image, ImageDraw
        full = Image.new("RGB", (408, 528), "white")
        draw = ImageDraw.Draw(full)
        for y in range(40, 500, 12):
            draw.line((30, y, 380, y), fill="black", width=3)
        paths = []
        for n, image in enumerate((full, Image.new("RGB", (408, 528), "white"), Image.new("RGB", (408, 528), "white")), 1):
            path = folder / f"page-{n:03d}.png"
            image.save(path)
            paths.append(path)
        notes = design_checks.check(design_html.parse("<p>x</p>"), {"format": "document", "w": 816, "h": 3000}, {},
                                    pages=paths)
        self.assertTrue(any(n.startswith("Page 2 of the printed document") for n in notes), notes)
        self.assertFalse(any("3" in n.split("of the printed")[0] for n in notes if "printed" in n), "the last page may be short")


def layout_of(elements, w=1920, h=1080):
    base_style = {"display": "block", "visibility": "visible", "backgroundColor": "rgba(0, 0, 0, 0)", "backgroundImage": "none",
                  "boxShadow": "none", "filter": "none", "transform": "none", "clipPath": "none", "maskImage": "none",
                  "mixBlendMode": "normal", "opacity": "1", "borderTopWidth": "0px", "borderRightWidth": "0px",
                  "borderBottomWidth": "0px", "borderLeftWidth": "0px", "borderTopStyle": "none", "borderTopColor": "rgb(0, 0, 0)",
                  "borderTopLeftRadius": "0px", "paddingTop": "0px", "paddingRight": "0px", "paddingBottom": "0px",
                  "paddingLeft": "0px", "fontFamily": '"Inter", sans-serif', "fontSize": "32px", "fontWeight": "400",
                  "fontStyle": "normal", "lineHeight": "40px", "letterSpacing": "normal", "textAlign": "left",
                  "textTransform": "none", "color": "rgb(20, 20, 20)", "writingMode": "horizontal-tb", "listStyleType": "none"}
    out = []
    for e in elements:
        out.append({"parent": "", "x": 0, "y": 0, "w": 100, "h": 100, **e, "style": {**base_style, **e.get("style", {})}})
    return {"w": w, "h": h, "elements": out}


class PptxPlanTests(unittest.TestCase):
    def test_what_becomes_native_and_what_stays_in_the_picture(self):
        layout = layout_of([
            {"id": "sec1", "tag": "section", "w": 1920, "h": 1080, "style": {"backgroundImage": "linear-gradient(red, blue)"}},
            {"id": "h1", "tag": "h1", "parent": "sec1", "x": 100, "y": 100, "w": 900, "h": 120,
             "runs": [{"text": "Signups tripled", "color": "rgb(255, 255, 255)", "weight": "700", "size": "96px"}]},
            {"id": "btn1", "tag": "div", "parent": "sec1", "x": 100, "y": 300, "w": 300, "h": 80,
             "style": {"backgroundColor": "rgb(0, 200, 120)", "borderTopLeftRadius": "999px"}, "runs": [{"text": "Start free"}]},
            {"id": "card1", "tag": "div", "parent": "sec1", "x": 1000, "y": 100, "w": 800, "h": 600,
             "style": {"backgroundColor": "rgb(30, 30, 30)", "boxShadow": "0 8px 24px rgba(0,0,0,.3)"}},
            {"id": "img1", "tag": "img", "parent": "card1", "x": 1040, "y": 140, "w": 720, "h": 400, "src": "data:image/png;base64,AAAA"},
            {"id": "fig1", "tag": "figure", "parent": "sec1", "chart": "bar", "x": 100, "y": 500, "w": 800, "h": 450},
            {"id": "svg1", "tag": "svg", "parent": "fig1", "x": 100, "y": 500, "w": 800, "h": 450},
            {"id": "svg2", "tag": "svg", "parent": "sec1", "x": 1500, "y": 900, "w": 100, "h": 100},
            {"id": "tilt", "tag": "div", "parent": "sec1", "x": 1200, "y": 800, "w": 300, "h": 100, "style": {"transform": "rotate(4deg)"}},
            {"id": "p9", "tag": "p", "parent": "tilt", "x": 1200, "y": 800, "w": 300, "h": 100, "runs": [{"text": "Tilted"}]},
        ])
        parts = {(p["el"]["id"], p["kind"]): p["hide"] for p in design_pptx.plan(layout, {"fig1": {"type": "bar"}})}
        self.assertEqual(parts[("h1", "text")], "text")
        self.assertEqual(parts[("btn1", "shape")], "box", "a solid pill is a native rounded shape")
        self.assertEqual(parts[("btn1", "text")], "text")
        self.assertEqual(parts[("img1", "picture")], "all", "the picture on a shadowed card is still a picture")
        self.assertEqual(parts[("svg1", "chart")], "all")
        self.assertNotIn(("card1", "shape"), parts, "a shadow PowerPoint can't draw stays in the picture")
        self.assertNotIn(("sec1", "shape"), parts, "a gradient stays in the picture")
        self.assertFalse(any(k[0] == "svg2" for k in parts), "a drawing stays in the picture")
        self.assertFalse(any(k[0] == "p9" for k in parts), "text in a rotated box stays with it")

    def test_a_shape_a_flattened_element_paints_over_stays_in_the_picture(self):
        layout = layout_of([
            {"id": "box1", "tag": "div", "x": 0, "y": 0, "w": 400, "h": 400, "style": {"backgroundColor": "rgb(200, 0, 0)"}},
            {"id": "glow", "tag": "div", "x": 100, "y": 100, "w": 400, "h": 400,
             "style": {"backgroundImage": "radial-gradient(white, transparent)"}},
        ])
        self.assertEqual(design_pptx.plan(layout, {}), [], "the red box would otherwise jump above its glow")

    def test_hidden_and_empty_elements_are_skipped(self):
        layout = layout_of([{"id": "t1", "tag": "table", "w": 0, "h": 0, "runs": [{"text": "x"}]},
                            {"id": "p1", "tag": "p", "style": {"visibility": "hidden"}, "runs": [{"text": "y"}]}])
        self.assertEqual(design_pptx.plan(layout, {}), [])

    def test_office_fonts_or_design_fonts(self):
        data = {"design_system": "tech-dark"}
        office, design = design_pptx.Fonts(data, "office"), design_pptx.Fonts(data, "design")
        from core import design_looks
        names = design_looks.summary(design_looks.get("tech-dark"))["fonts"]
        office_names = design_looks.get("tech-dark")["office_fonts"]
        self.assertEqual(office.name(f'"{names["display"]}", sans-serif'), office_names["display"])
        self.assertEqual(office.name(f'"{names["body"]}", sans-serif'), office_names["body"])
        self.assertEqual(design.name(f'"{names["display"]}", sans-serif'), names["display"])
        kairos = design_pptx.Fonts({"design_system": "kairos"}, "office")
        self.assertEqual(kairos.name('"Cormorant Garamond", serif'), "Garamond")

    def test_the_line_estimate(self):
        self.assertEqual(design_pptx._lines(["one two three"], None, 20, 10_000, "normal"), 1)
        self.assertGreater(design_pptx._lines(["one two three four five six seven"], None, 20, 120, "normal"), 2)
        # Benchmark findings (Sport look in Impact): a word wider than its box breaks inside it in PowerPoint,
        # and a faked bold sets wider.
        self.assertEqual(design_pptx._lines(["TEAMWORK"], None, 40, 120, "normal"), 2)
        self.assertGreater(design_pptx._lines(["a b c d e f g h"], None, 20, 90, "normal", widen=1.5),
                           design_pptx._lines(["a b c d e f g h"], None, 20, 90, "normal"))
        self.assertIn("impact", design_pptx.HEAVY)


def slide_layout():
    """What the window would measure for a two-element slide with a chart."""
    return layout_of([
        {"id": "sec1", "tag": "section", "w": 1920, "h": 1080, "style": {"backgroundColor": "rgb(10, 20, 30)"}},
        {"id": "h1", "tag": "h1", "parent": "sec1", "x": 120, "y": 120, "w": 900, "h": 120,
         "style": {"fontFamily": '"Space Grotesk", sans-serif', "fontSize": "96px", "lineHeight": "100px", "fontWeight": "700"},
         "runs": [{"text": "Signups ", "color": "rgb(240, 240, 240)", "weight": "700", "size": "96px", "family": '"Space Grotesk"'},
                  {"text": "tripled", "color": "rgb(240, 240, 240)", "weight": "700", "italic": True, "size": "96px",
                   "family": '"Space Grotesk"'}]},
        {"id": "p1", "tag": "p", "parent": "sec1", "x": 120, "y": 260, "w": 160, "h": 40,
         "runs": [{"text": "A sentence far too long for a box this small to hold in PowerPoint", "size": "32px"}]},
        {"id": "fig1", "tag": "figure", "parent": "sec1", "chart": "bar", "x": 1000, "y": 300, "w": 800, "h": 450},
        {"id": "svg1", "tag": "svg", "parent": "fig1", "x": 1000, "y": 300, "w": 800, "h": 450},
    ])


class PptxExportTests(unittest.TestCase):
    def test_an_editable_deck_through_the_job_stream(self):
        board = ('<section><h1>Signups tripled</h1><p>Long</p>' + BAR + '</section>')
        design_id, _ = make([{"title": "Growth", "format": "slides", "orientation": "landscape", "html": board},
                             {"title": "Home", "format": "website", "orientation": "landscape", "html": "<h1>Site</h1>"}],
                            look="tech-dark")
        root = design_html.parse(design_store.board_html(design_id, "growth"))
        ids = {n.tag: n.kd for n in root.elements() if n.tag in ("section", "h1", "p", "figure", "svg")}
        measured = json.dumps(slide_layout()).replace('"sec1"', f'"{ids["section"]}"').replace('"h1"', f'"{ids["h1"]}"', 1) \
            .replace('"fig1"', f'"{ids["figure"]}"').replace('"svg1"', f'"{ids["svg"]}"').replace('"p1"', f'"{ids["p"]}"')

        def answer(job):
            if job["kind"] == "layout":
                return measured.encode()
            return _png(1920 * job.get("scale", 1) // 8, 1080 * job.get("scale", 1) // 8)

        async def scenario():
            return await design_export.export(design_id, "pptx")
        (name, deck, notes), jobs = isolated(with_worker(answer, scenario))
        self.assertTrue(name.endswith(".pptx"))
        kinds = [j["kind"] for j in jobs]
        self.assertIn("layout", kinds)
        hidden = next(j for j in jobs if j["kind"] == "png" and j["hide"])["hide"]
        self.assertIn({"id": ids["h1"], "mode": "text"}, hidden)
        self.assertIn({"id": ids["svg"], "mode": "all"}, hidden)
        from pptx import Presentation
        presentation = Presentation(io.BytesIO(deck))
        self.assertEqual((presentation.slide_width, presentation.slide_height), (12192000, 6858000), "13.333 x 7.5 in")
        first, *website = presentation.slides  # The website is a pair: desktop and mobile.
        boxes = {s.name: s for s in first.shapes}
        headline = boxes[f"kd {ids['h1']} text"].text_frame
        self.assertEqual(headline.text, "Signups tripled")
        runs = headline.paragraphs[0].runs
        self.assertTrue(runs[0].font.bold and runs[1].font.italic)
        from core import design_looks
        self.assertEqual(runs[0].font.name, design_looks.get("tech-dark")["office_fonts"]["display"])
        self.assertEqual(runs[0].font.size.pt, 48.0, "96px on a 1920 slide is 48pt")
        chart = next(s for s in first.shapes if s.has_chart).chart
        self.assertEqual(list(chart.plots[0].categories), ["Jan", "Feb", "Mar"])
        self.assertEqual(chart.value_axis.maximum_scale, 3000)
        self.assertTrue(first.background.fill.type is not None, "a flat background is the slide's own fill")
        self.assertTrue(any(n.startswith("1 text box may overflow") for n in notes), notes)
        self.assertTrue(any("Placed as pictures" in n and "Home" in n for n in notes), notes)
        self.assertEqual(len(website), 2)
        self.assertTrue(all(any(s.shape_type == 13 for s in slide.shapes) for slide in website), "website boards are picture slides")

    def test_exact_picture_slides_and_bad_options(self):
        design_id, _ = make([{"title": "One", "format": "slides", "orientation": "landscape", "html": "<h1>One</h1>"}])

        async def scenario():
            return await design_export.export(design_id, "pptx", pptx_mode="pictures")
        (name, deck, notes), jobs = isolated(with_worker(lambda job: _png(240, 135), scenario))
        self.assertEqual({j["kind"] for j in jobs}, {"png"}, "no layout job for picture slides")
        self.assertEqual(notes, [])
        with self.assertRaises(ValueError):
            run(design_export.pptx(design_id, ["one"], mode="vector"))
        with self.assertRaises(ValueError):
            run(design_export.pptx(design_id, ["one"], fonts="comic"))

    def test_a_poster_is_editable_at_its_own_size(self):
        design_id, _ = make([{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>Spring</h1>"}])
        root = design_html.parse(design_store.board_html(design_id, "poster"))
        h1 = next(n.kd for n in root.elements() if n.tag == "h1")
        measured = json.dumps(layout_of([{"id": h1, "tag": "h1", "x": 80, "y": 80, "w": 1000, "h": 200,
                                          "runs": [{"text": "Spring"}]}], 1200, 1800))

        async def scenario():
            return await design_export.export(design_id, "pptx")
        (_, deck, _), _ = isolated(with_worker(lambda job: measured.encode() if job["kind"] == "layout" else _png(150, 225), scenario))
        from pptx import Presentation
        presentation = Presentation(io.BytesIO(deck))
        self.assertEqual((presentation.slide_width, presentation.slide_height), (1200 * 6350, 1800 * 6350))
        self.assertIn("Spring", [s.text_frame.text for s in presentation.slides[0].shapes if s.has_text_frame])


class PagedRenderTests(unittest.TestCase):
    def test_render_jobs_say_paged_and_carry_only_valid_hides(self):
        design_id, _ = make([{"title": "Guide", "format": "document", "orientation": "portrait", "html": GUIDE}])

        async def scenario():
            await design_render_bridge.render(design_id, "guide", "png",
                                              hide=[{"id": "h1", "mode": "text"}, {"id": "BAD id", "mode": "all"},
                                                    {"id": "p1", "mode": "explode"}])
            return await design_render_bridge.render(design_id, "guide", "pdf")
        _, jobs = isolated(with_worker(lambda job: _png(816, 1056) if job["kind"] == "png" else base._pdf(), scenario))
        self.assertTrue(all(j["paged"] for j in jobs))
        self.assertEqual(jobs[0]["hide"], [{"id": "h1", "mode": "text"}])

    def test_a_documents_pdf_keeps_every_page_and_pages_are_cached(self):
        design_id, _ = make([{"title": "Guide", "format": "document", "orientation": "portrait", "html": GUIDE}])
        import pypdfium2 as pdfium

        def three_pages():
            doc = pdfium.PdfDocument.new()
            for _ in range(3):
                doc.new_page(612, 792)
            out = io.BytesIO(); doc.save(out); doc.close()
            return out.getvalue()

        async def scenario():
            name, raw, _ = await design_export.export(design_id, "pdf")
            images = await design_render_bridge.pages(design_id, "guide")
            return raw, images
        (raw, images), _ = isolated(with_worker(lambda job: three_pages() if job["kind"] == "pdf" else _png(), scenario))
        self.assertEqual(len(pdfium.PdfDocument(raw)), 3)
        self.assertEqual(len(images), 3)
        self.assertEqual(len(design_render_bridge.cached_pages(design_id, "guide")), 3)
        page = client().get(f"/api/designs/{design_id}/boards/guide/pages/2")
        self.assertEqual(page.status_code, 200)
        self.assertTrue(page.content.startswith(b"\x89PNG"))
        self.assertEqual(client().get(f"/api/designs/{design_id}/boards/guide/pages/9").status_code, 404)

    def test_the_model_reads_blank_pages_in_the_same_reply(self):
        """Phase 2 benchmark finding: a page break before every section left near-empty pages, and the check
        only saw pages rendered later. Now design_create prints the pages first."""
        import pypdfium2 as pdfium

        def blank_pages():
            doc = pdfium.PdfDocument.new()
            for _ in range(3):
                doc.new_page(612, 792)
            out = io.BytesIO(); doc.save(out); doc.close()
            return out.getvalue()

        async def scenario():
            sid = new_chat()
            return await tool_registry.call("design_create", {"title": "Guide", "look": "sport", "boards": [
                {"title": "Guide", "format": "document", "orientation": "portrait", "html": GUIDE}]}, ctx(sid), tool_registry.OPENAI)
        result, jobs = isolated(with_worker(lambda job: blank_pages() if job["kind"] == "pdf" else _png(), scenario))
        self.assertIn("pdf", [j["kind"] for j in jobs])
        self.assertIn("Page 2 of the printed document is mostly blank", text(result), "the cover and last page may be sparse")

    def test_the_pages_route_is_for_document_boards(self):
        design_id, _ = make([{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>x</h1>"}])
        self.assertEqual(client().get(f"/api/designs/{design_id}/boards/poster/pages").status_code, 404)


class WordTests(unittest.TestCase):
    def test_a_document_board_in_word(self):
        design_id, _ = make([{"title": "Guide", "format": "document", "orientation": "portrait", "size": "a4", "html": GUIDE}],
                            look="sport", title="PSA Guide")
        response = client().post(f"/api/designs/{design_id}/export", json={"format": "docx"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["notes"], [])
        raw, notes = design_docx.build(design_id, ["guide"])
        import docx
        from core import design_looks
        document = docx.Document(io.BytesIO(raw))
        office = design_looks.get("sport")["office_fonts"]
        styles = {p.style.name: p.text for p in document.paragraphs if p.text}
        self.assertEqual(styles.get("Heading 1"), "Coaching guide")
        self.assertEqual(document.styles["Heading 1"].font.name, office["display"])
        self.assertEqual(document.styles["Normal"].font.name, office["body"])
        self.assertIn("List Bullet", styles)
        self.assertIn("Quote", styles)
        xml = zipfile.ZipFile(io.BytesIO(raw)).read("word/document.xml").decode()
        self.assertIn("<w:tblHeader", xml, "the table header repeats")
        self.assertNotIn("majorHAnsi", zipfile.ZipFile(io.BytesIO(raw)).read("word/styles.xml").decode().split("Heading1")[1][:600],
                         "the heading names the look's font, not the theme's")
        self.assertTrue(any(name.startswith("word/media/") for name in zipfile.ZipFile(io.BytesIO(raw)).namelist()), "the chart picture")
        footer = "".join(zipfile.ZipFile(io.BytesIO(raw)).read(n).decode() for n in zipfile.ZipFile(io.BytesIO(raw)).namelist()
                         if n.startswith("word/footer"))
        self.assertIn("NUMPAGES", footer)
        section = document.sections[0]
        self.assertAlmostEqual(section.page_width.inches, 794 / 96, places=2)
        self.assertTrue(section.different_first_page_header_footer)

    def test_every_numbered_list_starts_at_one(self):
        """Phase 2 benchmark finding (Codex's mock trial guide in Word): the second list carried on at 5."""
        design_id, _ = make([{"title": "Guide", "format": "document", "orientation": "portrait",
                              "html": "<h2>A</h2><ol><li>a</li><li>b</li></ol><h2>B</h2><ol><li>c</li><li>d</li></ol>"}])
        raw, _ = design_docx.build(design_id, ["guide"])
        import docx
        ids = [p._p.pPr.numPr.numId.val for p in docx.Document(io.BytesIO(raw)).paragraphs if p.style.name == "List Number"]
        self.assertEqual(len(ids), 4)
        self.assertEqual(ids[0], ids[1])
        self.assertNotEqual(ids[1], ids[2], "the second list has its own numbering")
        xml = zipfile.ZipFile(io.BytesIO(raw)).read("word/numbering.xml").decode()
        self.assertGreaterEqual(xml.count('w:startOverride w:val="1"'), 2)

    def test_light_ink_from_a_dark_look_turns_dark_on_white(self):
        palette = design_docx.Palette({"--ds-text": "#F2F2F2", "--ds-text-dim": "#A0A8B0", "--ds-accent": "#C8FF3E"})
        from core import design_looks
        self.assertGreaterEqual(design_looks._contrast(palette.text, "#FFFFFF"), 12)
        self.assertGreaterEqual(design_looks._contrast(palette.dim, "#FFFFFF"), 6)

    def test_a_design_with_no_document_board_says_so(self):
        design_id, _ = make([{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>x</h1>"}])
        with self.assertRaises(ValueError) as caught:
            run(design_export.export(design_id, "docx"))
        self.assertIn("document boards", str(caught.exception))


class SurfaceTests(unittest.TestCase):
    def test_the_export_tool_offers_every_option(self):
        spec = tool_registry._REGISTRY["design_export"]
        properties = spec.schema["properties"]
        self.assertEqual(properties["format"]["enum"], ["html", "png", "pdf", "pptx", "docx"])
        self.assertEqual(properties["pptx_mode"]["enum"], ["editable", "pictures"])
        self.assertEqual(properties["fonts"]["enum"], ["office", "design"])
        self.assertIn("editable", spec.description)

    def test_the_tool_reply_carries_the_notes(self):
        sid = new_chat()
        made = text(call("design_create", {"title": "Poster", "look": "sport", "boards": [
            {"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>x</h1>"}]}, ctx(sid)))
        design_id = re.search(r"Created design ([a-f0-9]{12})", made).group(1)
        reply = text(call("design_export", {"design_id": design_id, "format": "docx"}, ctx(sid)))
        self.assertIn("document boards", reply)

    def test_the_worker_knows_the_new_jobs(self):
        js = (REPO / "electron" / "designRender.js").read_text(encoding="utf-8")
        self.assertIn("['png', 'pdf', 'layout'].includes(job.kind)", js)
        self.assertIn("const KD_ID = /^[a-z][a-z0-9-]{0,47}$/;", js)
        self.assertIn("job.paged", js)
        for mode in ("text:", "box:", "all:"):
            self.assertIn(mode, js.split("const HIDE_RULES")[1].split("};")[0])

    def test_skills_and_prompt(self):
        skill = (REPO / "skill_templates" / "pdf-document" / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(skill.startswith("---\nname: pdf-document\n"))
        for word in ("report", "guide", "cheat sheet", "one-pager", "proposal", "resume", "worksheet", "certificate",
                     "data-kd-page-break", '"document"'):
            self.assertIn(word, skill)
        canvas = (REPO / "skill_templates" / "design-canvas" / "SKILL.md").read_text(encoding="utf-8")
        for word in ('data-chart="bar"', "`document`", "big-statement", "image-led", "two-column", "**chart**", "closing",
                     "pptx_mode", "docx"):
            self.assertIn(word, canvas)
        from core import creative_direction, system_prompt
        self.assertIn("document or PDF", system_prompt.DESIGN_CANVAS_LINE)
        files_rule = system_prompt._GENERATED_FILES_ADDENDUM("your file tools", "call save_generated_file")
        self.assertTrue(files_rule.startswith("A designed PDF, report, guide, Word document, slide deck or poster comes from "
                                              "the Design canvas"), "the files rule no longer sends PDFs to a script")
        self.assertIn("format document", creative_direction.describe("a 4 page guide as a PDF", "print"))
        registry = (REPO / "core" / "tool_registry.py").read_text(encoding="utf-8")
        self.assertIn("comes from the Design canvas instead", registry)


if __name__ == "__main__":
    unittest.main()
