"""The bundled motion-video template is self-contained and has neutral starters."""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services import skills_service
import yaml

TEMPLATE = ROOT / "skill_templates" / "motion-video"
STARTERS = ("motion-starter.html", "motion-soundtrack.mjs", "motion-render.mjs")


class MotionVideoSkillTests(unittest.TestCase):
    def test_frontmatter(self):
        raw = (TEMPLATE / "SKILL.md").read_text(encoding="utf-8")
        match = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
        self.assertIsNotNone(match, "Missing YAML frontmatter")
        metadata = yaml.safe_load(match.group(1))
        self.assertEqual(metadata["name"], TEMPLATE.name)
        self.assertIsInstance(metadata["description"], str)
        self.assertTrue(metadata["description"].strip())
        self.assertEqual(metadata["license"], "MIT")
        self.assertEqual(metadata["metadata"]["version"], "1.0.0")
        # Check the app's lightweight parser agrees with YAML parsing.
        self.assertEqual(skills_service._parse(raw)["description"], metadata["description"])

    def test_top_level_starters_are_referenced_and_unbranded(self):
        skill = (TEMPLATE / "SKILL.md").read_text(encoding="utf-8")
        for name in STARTERS:
            with self.subTest(starter=name):
                file = TEMPLATE / name
                self.assertTrue(file.is_file(), "Starters must be top-level files for seeding")
                self.assertIn(name, skill)
                self.assertNotIn("kairos", file.read_text(encoding="utf-8").lower())


if __name__ == "__main__":
    unittest.main()
