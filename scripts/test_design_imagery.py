"""Offline look defaults, picture checks and design lint wiring."""
import io
import os
import sys
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data_support import TestDataDirectory

_DATA = TestDataDirectory(prefix="kairos-imagery-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image
from core import creative_direction, design_checks, design_html, design_looks, design_store, design_systems, design_tools
from core.image_treatments import TREATMENTS, PATTERNS


class ImageryTests(unittest.TestCase):
    def notes(self, html, fmt="poster", **kw):
        return design_checks.check(design_html.parse(html), {"format": fmt, "w": 1200, "h": 1800}, {}, **kw)

    def test_looks_and_variety(self):
        looks = list(design_looks.load(refresh=True).values())
        self.assertEqual(len(looks), 23)
        for look in looks:
            self.assertIn(look["image_treatment"], TREATMENTS)
            self.assertIn(look["pattern"], PATTERNS)
            summary = design_looks.summary(look)
            for field in ("image_treatment", "pattern"):
                self.assertEqual(summary[field], look[field])
                self.assertIn(look[field], design_looks.guide(look))
        looks.append(design_systems.builtin()["look"])
        for field in ("image_treatment", "pattern"):
            self.assertLessEqual(max(Counter(look[field] for look in looks).values()), 6)

    def test_prompt_and_skill_picture_guidance(self):
        from core.system_prompt import DESIGN_CANVAS_LINE
        self.assertIn("Pictures come from image_generate, image_search (openly licensed photos, credit on the board), "
                      "image_treat or image_pattern; never draw pictures or clip art in code.", DESIGN_CANVAS_LINE)
        repo = Path(__file__).resolve().parents[1]
        for name, version in (("design-canvas", "1.1.0"), ("poster", "2.1.0"), ("pdf-document", "1.1.0")):
            raw = (repo / "skill_templates" / name / "SKILL.md").read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertFalse(raw.startswith(bytes.fromhex("efbbbf")))
            text = raw.decode("utf-8")
            self.assertIn(f'version: "{version}"', text)
            self.assertIn("## Pictures", text)
        canvas = (repo / "skill_templates/design-canvas/SKILL.md").read_text(encoding="utf-8")
        for word in ("image_treat", "image_generate", "image_search", "image_pattern", "object-fit: cover", "scrim"):
            self.assertIn(word, canvas)

    def test_invalid_fields(self):
        look = design_looks.get("sport")
        for field in ("image_treatment", "pattern"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                design_looks._validate("bad", {**look, field: "unknown"})

    def test_legacy_reference_style_defaults(self):
        look = dict(design_looks.get("sport"))
        del look["image_treatment"]
        del look["pattern"]
        clean = design_looks._validate("draft", look)
        self.assertEqual((clean["image_treatment"], clean["pattern"]), ("duotone", "dots"))
        saved = design_systems.save_style(look, owner="local", sources=[])
        self.assertEqual(saved["look"]["image_treatment"], "duotone")

    def test_direction_dict_and_text(self):
        with patch.object(creative_direction, "_recent", return_value=[]):
            for brief in ("soccer camp", "Kairos launch"):
                directions = creative_direction.directions(brief, "poster")
                text = creative_direction.describe(brief, "poster")
                for d in directions:
                    self.assertIn(d["image_treatment"], TREATMENTS)
                    self.assertIn(d["pattern"], PATTERNS)
                    line = next(line for line in text.splitlines() if "Imagery: " + d["imagery"] in line)
                    self.assertIn("image_treat " + d["image_treatment"], line)
                    self.assertIn("image_pattern " + d["pattern"], line)
                    self.assertIn("image_generate (when connected)", line)
                    self.assertIn("image_search for an openly licensed photo", line)

    def test_no_picture(self):
        for fmt in ("poster", "social", "banner"):
            self.assertTrue(any(f"This {fmt} has no picture." in n for n in self.notes("<h1>Hello</h1>", fmt)))
        for fmt in ("slides", "document", "website"):
            self.assertEqual(self.notes("<h1>Hello</h1>", fmt), [])

    def test_good_pictures(self):
        for html in ('<img src="assets/photo.png" alt="A runner">',
                     '<div style="background-image: url(assets/pattern.png); width: 1200px; height: 1800px"></div>',
                     '<div style="background: url(assets/pattern.png)">Camp</div>',
                     '<picture><img src="assets/photo.png" alt="A runner"></picture>',
                     '<figure data-chart="bar"><table><tr><td>Jan</td><td>5</td></tr></table></figure>',
                     '<svg><path/><circle/><rect/></svg>'):
            with self.subTest(html=html):
                self.assertEqual(self.notes(html, assets={"photo.png", "pattern.png"}), [])

    def test_missing_asset(self):
        for html in ('<img src="assets/lost.png">', '<div style="background: url(\'assets/lost.png\')">Hi</div>'):
            self.assertEqual(self.notes(html, assets=set()), ["Image lost.png isn't in this design's assets; use a path an image tool returned."])
            self.assertEqual(self.notes(html), [])

    def test_missing_credit(self):
        credits = {"assets/photo.png": {"creator": "Alex Smith", "title": "Runner", "license": "cc-by", "license_version": "4.0"}}
        html = '<img src="assets/photo.png" alt="Alex Smith">'
        expected = 'Photo by Alex Smith needs its credit on the board: "Photo: Runner by Alex Smith, CC-BY 4.0" in small type.'
        self.assertEqual(self.notes(html, credits=credits), [expected])
        self.assertEqual(self.notes(html + '<p>Photo: Runner by ALEX SMITH, CC-BY 4.0</p>', credits=credits), [])
        self.assertEqual(self.notes(html + '<p hidden>Alex Smith</p>', credits=credits), [expected])
        self.assertEqual(self.notes('<img src="assets/other.png">', credits=credits), [])
        self.assertEqual(self.notes('<div style="background-image: url(assets/photo.png)">Hi</div>', credits=credits), [expected])

    def test_drawn_clip_art_and_chart_exemptions(self):
        drawing = '<svg>' + '<path d="M0 0 L1 1"/>' * 41 + '</svg>'
        for fmt in ("poster", "social", "banner", "slides"):
            self.assertTrue(any("draws a picture in code" in n for n in self.notes(drawing, fmt)))
        self.assertEqual(self.notes(drawing, "document"), [])
        self.assertEqual(self.notes('<svg>' + '<path/>' * 40 + '</svg>'), [])
        self.assertEqual(self.notes(drawing.replace('<svg>', '<svg data-kd-chart-out>')), [])
        self.assertEqual(self.notes('<figure data-chart="bar" data-kd-chart-out>' + drawing + '</figure>'), [])

    def test_lint_assets_and_credit_end_to_end(self):
        data, _ = design_store.create("Pictures", owner="local", chat_key_=None, by="test",
                                      boards=[{"title": "Poster", "format": "poster", "orientation": "portrait", "html": "<h1>Camp</h1>"}])
        slug = next(iter(data["boards"]))
        out = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(out, "PNG")
        asset = design_store.add_asset(data["id"], out.getvalue(), "png")
        design_store.add_credit(data["id"], asset, {"creator": "Alex", "title": "Camp", "license": "cc-by"})
        html = f'<img src="{asset}" alt="Camp in daylight">'
        self.assertTrue(any("Photo by Alex" in n for n in design_tools._lint(data, slug, html)))
        self.assertEqual(design_tools._lint(data, slug, html + '<p>Photo: Camp by Alex, CC-BY</p>'), [])
        missing = design_tools._lint(data, slug, '<img src="assets/missing.png" alt="Camp">')
        self.assertTrue(any("Image missing.png isn't" in n for n in missing))
        self.assertTrue(any("has no picture" in n for n in design_tools._lint(data, slug)))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        _DATA.cleanup()
