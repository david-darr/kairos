"""The repository maps (2026-10-28) name real files and folders.

The root map is CLAUDE.md; each main folder has an AGENTS.md. (A root AGENTS.md
is a developer's own local pointer, gitignored, and never read here.) A map that
names a file that moved or was deleted sends a model looking in the wrong place,
so every backticked path in every map must exist: from the map's own folder,
from the repository root, or (a bare file name such as `tab.json`) somewhere
under the map's folder. Commands, placeholders, wildcards and runtime `data/`
paths are not paths and are skipped.

Run: python -B -X utf8 scripts/test_agents_maps.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOLDERS = ("core", "services", "routes", "static/js", "electron", "tabs", "scripts")
EXTENSIONS = (".py", ".js", ".cjs", ".mjs", ".md", ".json", ".css", ".html", ".nsh", ".txt")


def maps():
    return [ROOT / "CLAUDE.md"] + [ROOT / folder / "AGENTS.md" for folder in FOLDERS]


def named_paths(text):
    for token in re.findall(r"`([^`\n]+)`", text):
        if any(c in token for c in " <>*=\\(") or token.startswith(("-", ".", "data/")):
            continue
        if "/" in token or token.endswith(EXTENSIONS):
            yield token


class AgentsMapTests(unittest.TestCase):
    def test_the_expected_maps_exist(self):
        for map_file in maps():
            self.assertTrue(map_file.is_file(), map_file.relative_to(ROOT))
        root = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
        for folder in FOLDERS:
            self.assertIn(f"`{folder}/`", root, "the root map lists every folder map")

    def test_every_named_path_exists(self):
        missing = []
        for map_file in maps():
            here = map_file.parent
            for token in named_paths(map_file.read_text(encoding="utf-8")):
                name = token.rstrip("/")
                if (here / name).exists() or (ROOT / name).exists():
                    continue
                if "/" not in name and any(here.rglob(name)):
                    continue
                missing.append(f"{map_file.relative_to(ROOT).as_posix()}: `{token}`")
        self.assertEqual(missing, [], "maps name files that do not exist")

    def test_maps_stay_short(self):
        for map_file in maps():
            lines = map_file.read_text(encoding="utf-8").count("\n")
            self.assertLess(lines, 80, f"{map_file.relative_to(ROOT)} is a map, not documentation")


if __name__ == "__main__":
    unittest.main()
