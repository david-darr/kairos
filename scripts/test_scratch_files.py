"""Model working files go to generated_files/scratch and are swept after two days; deliverables are never touched."""
import os
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="scratch-test-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from core import image_gen, system_prompt


class ScratchTests(unittest.TestCase):
    def test_sweep_removes_only_old_scratch(self):
        scratch, out = Path(image_gen.SCRATCH_DIR), Path(image_gen.GENERATED_FILES_DIR)
        (scratch / "run1").mkdir(parents=True, exist_ok=True)
        old, fresh = scratch / "run1" / "boards.json", scratch / "edits.json"
        deliverable = out / "abc123_Guide.pdf"
        for path in (old, fresh, deliverable):
            path.write_text("{}", encoding="utf-8")
        week_ago = time.time() - 7 * 86400
        os.utime(old, (week_ago, week_ago))
        os.utime(deliverable, (week_ago, week_ago))
        self.assertEqual(image_gen.sweep_scratch(), 1)
        self.assertFalse(old.exists())
        self.assertFalse((scratch / "run1").exists(), "an emptied subfolder goes too")
        self.assertTrue(fresh.exists(), "recent scratch stays")
        self.assertTrue(deliverable.exists(), "deliverables are never swept")

    def test_register_moves_a_file_already_in_generated_files_whatever_its_case(self):
        out = Path(image_gen.GENERATED_FILES_DIR)
        out.mkdir(parents=True, exist_ok=True)
        source = out / "Story.png"
        source.write_bytes(b"png")
        spelled = str(source).upper() if os.name == "nt" else str(source)
        published = image_gen.register_generated_file(spelled.replace("\\", "/"))
        self.assertFalse(source.exists(), "no duplicate original is left beside the published copy")
        self.assertTrue(Path(published["path"]).is_file())

    def test_codex_is_told_where_scratch_goes(self):
        prompt = system_prompt.for_codex("python.exe", "cli.py")
        self.assertIn(image_gen.SCRATCH_DIR, prompt)
        self.assertIn("never beside deliverables", prompt)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        fixture.cleanup()
