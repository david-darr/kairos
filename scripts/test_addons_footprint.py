"""Optional-package footprint (A17 benchmark): tool-schema payload offered to a model
with no add-ons vs all installed, skill bytes loaded per package, install/disable
latency, and that a fresh base pays nothing. Isolated data dir, no external calls.
Run: python scripts/test_addons_footprint.py
"""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_addons as A
from core import addons, tool_registry
from services import skills_service

PKG = Path(__file__).resolve().parents[1] / "addon_packages"


def payload(surface="codex"):
    rows = [{"name": s.name, "description": s.description, "schema": s.schema} for s in tool_registry.specs(surface, True)]
    return len(rows), len(json.dumps(rows).encode())


class Footprint(A.Addons):
    pass


for _n in [n for n in dir(A.Addons) if n.startswith("test_")]:
    setattr(Footprint, _n, None)


class FootprintTests(Footprint):
    def test_tool_payload_and_skill_bytes_and_lifecycle_latency(self):
        addons.migrate()
        base_n, base_b = payload()
        times = {}
        for pid in ("blender", "higgsfield", "roblox"):
            t = time.perf_counter(); addons.change(pid, "install"); times[pid] = (time.perf_counter() - t) * 1000
        all_n, all_b = payload()
        skill_bytes = {p.name: sum(f.stat().st_size for f in (p / "skills").rglob("*.md")) if (p / "skills").exists() else 0
                       for p in PKG.iterdir() if p.is_dir()}
        # SKILL.md entry files are what a model loads; references are on demand
        entry = {p.name: sum(f.stat().st_size for f in (p / "skills").glob("*/SKILL.md")) for p in PKG.iterdir() if (p / "skills").exists()}
        t = time.perf_counter()
        for pid in ("blender", "higgsfield", "roblox"):
            addons.change(pid, "disable")
        off_ms = (time.perf_counter() - t) * 1000
        off_n, off_b = payload()
        print(f"[bench] addons tool schemas offered (codex/admin): base {base_n} tools {base_b} B; all installed {all_n} tools {all_b} B "
              f"(+{all_n - base_n} tools, +{all_b - base_b} B ~ +{(all_b - base_b) // 4} tok every turn); after disable {off_n} tools {off_b} B")
        print(f"[bench] addons skill SKILL.md bytes {entry}; all skill+reference md bytes {skill_bytes}")
        print(f"[bench] addons install ms {({k: round(v) for k, v in times.items()})}; disable all {off_ms:.0f} ms")
        self.assertEqual((off_n, off_b), (base_n, base_b))  # disable returns the model payload to the base
        self.assertGreaterEqual(all_n, base_n)


if __name__ == "__main__":
    unittest.main()
