"""A21 (Part 2, g8): dependency pinning, pinned Actions and packaging exclusions, read from the files.

Installs nothing and touches no network.
    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g8_supply_chain.py
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_runtime as br  # noqa: E402


class PythonPinningTests(unittest.TestCase):
    def test_every_requirement_has_an_upper_bound(self):
        self.assertEqual(br.unbounded_requirements(), [])

    def test_the_lock_hash_pins_every_requirement_and_the_policy_check_passes(self):
        br.check_pinning_policy()
        locked = br.locked_versions()
        self.assertGreater(len(locked), 60)
        for name in br.required_distributions():
            self.assertIn(name, locked, name)

    def test_every_locked_package_is_pinned_exactly_and_carries_hashes(self):
        text = (ROOT / "requirements.lock").read_text(encoding="utf-8")
        blocks = re.split(r"\n(?=[A-Za-z0-9_.\-\[\]]+==)", text)[1:]
        self.assertGreater(len(blocks), 60)
        bad = [b.splitlines()[0] for b in blocks if len(re.findall(r"--hash=sha256:[0-9a-f]{64}", b)) < 1]
        self.assertEqual(bad, [], "locked packages without a sha256 hash")
        unpinned = [l for l in text.splitlines() if re.match(r"^[A-Za-z0-9_.\-\[\]]+\s*(>=|<|~=|!=|>)", l)]
        self.assertEqual(unpinned, [])

    def test_the_lock_installs_from_pypi_only(self):
        text = (ROOT / "requirements.lock").read_text(encoding="utf-8")
        indexes = re.findall(r"^--(?:extra-)?index-url\s+(\S+)", text, re.M)
        self.assertEqual(indexes, ["https://pypi.org/simple"])
        for forbidden in ("--extra-index-url", "--find-links", "--trusted-host", "git+", "file:"):
            self.assertNotIn(forbidden, text)
        # direct URL references are limited to the exact wheel files the policy allows
        urls = re.findall(r"@\s*(https?://\S+)", (ROOT / "requirements.txt").read_text(encoding="utf-8"))
        for url in urls:
            self.assertTrue(url.startswith("https://") and url.endswith(".whl"), url)

    def test_the_runtime_is_installed_from_the_lock_with_hash_checking(self):
        source = (ROOT / "scripts" / "build_runtime.py").read_text(encoding="utf-8")
        self.assertIn("--require-hashes", source)
        self.assertIn("--no-deps", source)
        self.assertIn("check_pinning_policy()", source)


class ActionsPinningTests(unittest.TestCase):
    def test_every_action_is_pinned_to_a_full_commit_sha(self):
        workflows = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
        self.assertGreaterEqual(len(workflows), 2)
        uses = []
        for workflow in workflows:
            uses += [(workflow.name, m) for m in re.findall(r"uses:\s*(\S+)", workflow.read_text(encoding="utf-8"))]
        self.assertGreaterEqual(len(uses), 5)
        for name, ref in uses:
            if ref.startswith("./"):
                continue
            self.assertRegex(ref, r"@[0-9a-f]{40}$", f"{name}: {ref} is not pinned to a commit SHA")

    def test_workflows_do_not_pipe_downloads_into_a_shell(self):
        for workflow in (ROOT / ".github" / "workflows").glob("*.yml"):
            text = workflow.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"curl[^\n|]*\|\s*(ba)?sh", workflow.name)


# The one package allowed from outside the npm registry (David, 2026-11-03: "Allow the
# exception"): castlabs' Electron for Content Security, which adds Widevine for DRM video
# (Kairos Browser D2) and is published only on GitHub. Exactly this package, from exactly this
# host, pinned to one commit, with an integrity hash; its binary is checked against castlabs'
# SHASUMS256 on install. Anything else still has to come from the registry.
OUTSIDE_REGISTRY = {("electron/package-lock.json", "node_modules/electron"):
                    re.compile(r"^https://github\.com/castlabs/electron-releases/archive/[0-9a-f]{40}\.tar\.gz$")}


class NodeAndPackagingTests(unittest.TestCase):
    def test_npm_locks_use_integrity_hashes_and_the_public_registry(self):
        for rel in ("package-lock.json", "electron/package-lock.json"):
            lock = json.loads((ROOT / rel).read_text(encoding="utf-8"))
            packages = {k: v for k, v in lock["packages"].items() if k}
            self.assertGreater(len(packages), 10, rel)
            for key, info in packages.items():
                if info.get("link"):
                    continue
                if "resolved" in info:
                    allowed = OUTSIDE_REGISTRY.get((rel, key))
                    if allowed:
                        self.assertRegex(info["resolved"], allowed, f"{rel} {key} must stay pinned to one castlabs commit")
                    else:
                        self.assertTrue(info["resolved"].startswith("https://registry.npmjs.org/"), f"{rel} {key}")
                    self.assertTrue(info.get("integrity", "").startswith("sha"), f"{rel} {key} has no integrity hash")

    def test_the_outside_registry_exception_is_exactly_castlabs_electron(self):
        lock = json.loads((ROOT / "electron" / "package-lock.json").read_text(encoding="utf-8"))
        entry = lock["packages"]["node_modules/electron"]
        self.assertRegex(entry["resolved"], OUTSIDE_REGISTRY[("electron/package-lock.json", "node_modules/electron")])
        self.assertTrue(entry["version"].endswith("+wvcus"), entry["version"])
        self.assertTrue(entry.get("integrity", "").startswith("sha512-"))
        manifest = json.loads((ROOT / "electron" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["devDependencies"]["electron"], entry["resolved"], "package.json names the same pinned commit")
        self.assertEqual(len(OUTSIDE_REGISTRY), 1)

    def test_the_installer_leaves_secrets_data_and_dev_files_out(self):
        build = json.loads((ROOT / "electron" / "package.json").read_text(encoding="utf-8"))["build"]
        backend = next(r for r in build["extraResources"] if r["to"] == "backend")
        filters = set(backend["filter"])
        for rule in ("!data/**", "!.env", "!.env.*", "!.git/**", "!.venv/**", "!electron/**", "!dist/**",
                     "!evals/**", "!scripts/*.key", "!scripts/*.pem", "!scripts/*.crt", "!**/*.log"):
            self.assertIn(rule, filters)
        self.assertEqual(build["win"]["target"][0]["target"], "nsis")
        self.assertEqual([t["arch"] for t in build["win"]["target"]], [["x64"]])  # no unbuilt Intel Mac / Linux

    def test_licences_and_notices_ship(self):
        self.assertTrue((ROOT / "LICENSE").stat().st_size > 100)
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("Permission is hereby granted", notices)
        self.assertGreater(len(re.findall(r"^## ", notices, re.M)), 0)
        for vendored in sorted((ROOT / "static" / "vendor").iterdir()):
            if vendored.is_dir() and vendored.name.startswith("ascii-magic"):
                self.assertIn("ascii-magic", notices)


if __name__ == "__main__":
    unittest.main()
