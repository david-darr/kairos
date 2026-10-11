"""The bundled rebuild-from-reference template parses and ships its worksheet."""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services import skills_service
import yaml

TEMPLATE = ROOT / "skill_templates" / "rebuild-from-reference"
WORKSHEET = "behavior-spec.md"


class RebuildSkillTests(unittest.TestCase):
    def setUp(self):
        self.raw = (TEMPLATE / "SKILL.md").read_text(encoding="utf-8")

    def test_frontmatter(self):
        match = re.match(r"^---\n(.*?)\n---\n", self.raw, re.S)
        self.assertIsNotNone(match, "Missing YAML frontmatter")
        metadata = yaml.safe_load(match.group(1))
        self.assertEqual(metadata["name"], TEMPLATE.name)
        self.assertTrue(str(metadata["description"]).strip())
        self.assertEqual(metadata["license"], "MIT")
        self.assertEqual(metadata["metadata"]["version"], "1.0.0")
        self.assertEqual(skills_service._parse(self.raw)["description"], metadata["description"])

    def test_worksheet_is_a_referenced_top_level_file(self):
        # Only top-level files are seeded into a user's skills folder.
        self.assertTrue((TEMPLATE / WORKSHEET).is_file())
        self.assertIn(WORKSHEET, self.raw)
        self.assertFalse([p for p in TEMPLATE.iterdir() if p.is_dir()], "Subfolders are not seeded")

    def test_keeps_the_legal_and_scope_guardrails(self):
        # The method is observe-and-rebuild. These lines are why it stays that.
        for phrase in ("license", "Never copy code", "defeating a protection"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.raw)

    def test_no_em_dashes_in_user_facing_copy(self):
        for name in ("SKILL.md", WORKSHEET):
            with self.subTest(file=name):
                self.assertNotIn("—", (TEMPLATE / name).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
