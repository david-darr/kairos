import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from test_data_support import TestDataDirectory

ENV = TestDataDirectory("kairos-scout-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.bot_scout import scout, MAX_BYTES


class ScoutTests(unittest.TestCase):
    def setUp(self):
        import uuid
        self.root = Path(ENV.name) / uuid.uuid4().hex; self.root.mkdir()

    def test_evidence_and_no_project_path_in_persona(self):
        (self.root / "package.json").write_text(json.dumps({"dependencies": {"react": "1", "prisma": "1"}, "devDependencies": {"vitest": "1"}}))
        (self.root / "README.md").write_text("# Small project")
        (self.root / "Dockerfile").write_text("FROM example")
        result = scout(str(self.root))
        self.assertEqual(len(result["preview"]["bots"]), 6)
        self.assertEqual({e["key"] for e in result["evidence"]}, {"lead", "frontend", "tests", "docs", "data", "deploy"})
        self.assertNotIn(str(self.root), str(result["preview"]))

    def test_fallback_and_limit(self):
        self.assertEqual(scout(str(self.root))["preview"]["bots"][0]["key"], "general")
        (self.root / "README.md").write_bytes(b"a" * MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "256 KB"): scout(str(self.root))

    def test_traversal_and_links_refused(self):
        with self.assertRaises(ValueError): scout(str(self.root / ".." / self.root.name))
        with patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaises(ValueError): scout(str(self.root))
        with self.assertRaises(ValueError): scout("relative/folder")


if __name__ == "__main__": unittest.main()
