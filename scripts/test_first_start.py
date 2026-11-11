"""The first start of a new version on a large profile (2026-11-10, the 2.3.0 upgrade rehearsal on a copy of
David's 8 GB profile: 33 minutes of whole-folder zip before anything moved, the desktop app gave up after 2,
and the backup walker went through Windows junctions).

- The migration's safety net: a small safety copy plus a journal, written before anything moves; revert().
- Interruption: a child process running the migration is killed (TerminateProcess, as the desktop app's
  stopBackend() does) at random moments, again and again; every time, the next start must reach a
  consistent layout with every file in exactly one place, unchanged, and nothing left over.
- Junctions are never followed: by the backup (recorded by target, made again on restore), by the
  migration's copy and safety copy, and by removing a moved entry.
- The start-up progress answer on the app's port.

Runs on throwaway folders under the system temp folder; real junctions on Windows.
"""
import hashlib
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory  # noqa: E402

if __name__ == "__main__" and sys.argv[1:2] == ["--child"]:
    os.environ["JARVIS_DATA_DIR"] = sys.argv[2]
else:
    _DATA = TemporaryDirectory(prefix="kairos-first-start-", dir=tempfile.gettempdir())
    os.environ["JARVIS_DATA_DIR"] = _DATA.name

from core import account_migration as migration, links, startup_progress  # noqa: E402

ACCOUNT = "abc123"
STEPS = [migration.Step(1, "stores", ("notes.json", "calendar_events.json", "documents", "sessions.db",
                                      "sessions.db-wal", "sessions.db-shm", "chats")),
         migration.Step(2, "files", ("generated_files", "attachments", "file_checkpoints", "skills", "vault"),
                        copy_first=("vault",))]
FINAL = 2
MOVED = {name for step in STEPS for name in step.entries}
SLOW_RENAMES = {"generated_files", "chats"}  # refused, so they go the copy way: the one move that is not atomic


def junctions_work() -> bool:
    return os.name == "nt"


def make_profile(folder: Path, outside: Path) -> None:
    """A small data folder shaped like David's: stores at the top, entries of many files, a database with its
    write-ahead file, a vault, and a junction in generated_files pointing outside the data folder."""
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in (("notes.json", "[1, 2]"), ("calendar_events.json", "[]"), ("settings.json", '{"a": 1}'),
                       ("auth.json", "{}"), ("sessions.db", "SQLite format 3\0" + "x" * 5000),
                       ("sessions.db-wal", "w" * 3000), ("sessions.db-shm", "s" * 100),
                       ("mobile_activity.db", "SQLite format 3\0" + "m" * 2000)):
        (folder / name).write_text(text, encoding="utf-8")
    for i in range(40):
        (folder / "chats").mkdir(exist_ok=True)
        (folder / "chats" / f"c{i:03}.json").write_text(json.dumps({"i": i, "t": "x" * 300}), encoding="utf-8")
    for i in range(12):
        (folder / "documents").mkdir(exist_ok=True)
        (folder / "documents" / f"d{i}.md").write_text(f"doc {i}", encoding="utf-8")
    for d in range(12):
        sub = folder / "generated_files" / f"run{d:02}"
        sub.mkdir(parents=True)
        for i in range(15):
            (sub / f"f{i}.json" if i % 3 == 0 else sub / f"f{i}.txt").write_text(f"{d}-{i}" * 100, encoding="utf-8")
    for i in range(20):
        (folder / "attachments").mkdir(exist_ok=True)
        (folder / "attachments" / f"a{i}.bin").write_bytes(os.urandom(20000))
    for i in range(60):
        (folder / "file_checkpoints" / f"p{i % 6}").mkdir(parents=True, exist_ok=True)
        (folder / "file_checkpoints" / f"p{i % 6}" / f"k{i}.json").write_text("{}" * i, encoding="utf-8")
    for i in range(6):
        (folder / "skills" / f"s{i}").mkdir(parents=True)
        (folder / "skills" / f"s{i}" / "SKILL.md").write_text(f"skill {i}", encoding="utf-8")
        (folder / "skills" / f"s{i}" / "meta.json").write_text("{}", encoding="utf-8")
    (folder / "vault" / "daily").mkdir(parents=True)
    for i in range(10):
        (folder / "vault" / "daily" / f"n{i}.md").write_text(f"note {i}", encoding="utf-8")
    (folder / "logs").mkdir()
    (folder / "logs" / "backend.log").write_text("log", encoding="utf-8")
    if junctions_work():
        (outside / "node_modules" / "pkg").mkdir(parents=True, exist_ok=True)
        for i in range(30):
            (outside / "node_modules" / "pkg" / f"m{i}.json").write_text("{}", encoding="utf-8")
        snap = folder / "generated_files" / "run00" / "snapshot"
        snap.mkdir()
        links.make(str(snap / "node_modules"), str(outside / "node_modules"), "junction")


def manifest(folder: Path) -> dict:
    """Relative path -> sha1 of every file, links as "link:<target>", never following a link."""
    found = {}
    for current, _, files, found_links in links.walk(str(folder)):
        for name in files:
            path = os.path.join(current, name)
            found[os.path.relpath(path, folder).replace(os.sep, "/")] = hashlib.sha1(Path(path).read_bytes()).hexdigest()
        for name in found_links:
            path = os.path.join(current, name)
            found[os.path.relpath(path, folder).replace(os.sep, "/")] = "link:" + os.path.normcase(links.target(path))
    return found


def placed(folder: Path, version: int) -> dict:
    """The data folder's files as they would be named before the migration, checking each sits where the
    layout says it should: a moved entry only in the account folder, the rest only at the top."""
    account = f"accounts/{ACCOUNT}/"
    moved = {n for step in STEPS if step.version <= version for n in step.entries}
    result = {}
    for rel, digest in manifest(folder).items():
        if rel.startswith(".layout/") or rel == "layout.json":
            continue
        if rel.startswith(account):
            original = rel[len(account):]
            assert original.split("/")[0] in moved, f"{original} is in the account folder at layout {version}"
        else:
            original = rel
            assert original.split("/")[0] not in moved, f"{original} is still at the top at layout {version}"
        assert original not in result, f"{original} is in two places"
        result[original] = digest
    return result


# --- the child: the migration in a process of its own, to be killed ------------------------------------

def child(data_dir: str, mode: str) -> None:
    import shutil as shutil_module
    real_replace, real_copyfile, real_copy2, real_unlink = os.replace, shutil_module.copyfile, shutil_module.copy2, os.unlink
    real_durable = migration._replace_durably
    slow = not mode.endswith("-fast")
    failing = mode.startswith("failing")

    def replace(source, destination, *a, **k):
        name = os.path.basename(source)
        if name in SLOW_RENAMES and "accounts" in str(destination):
            raise PermissionError(13, "Access is denied (test)", source)
        if failing and name == "skills" and "accounts" in str(destination):
            raise PermissionError(13, "Access is denied (test)", source)
        if slow:
            time.sleep(0.03)
        return real_replace(source, destination, *a, **k)

    def copyfile(*a, **k):
        if slow:
            time.sleep(0.002)
        return real_copyfile(*a, **k)

    def copy2(source, destination, *a, **k):
        if failing and os.path.basename(source) == "SKILL.md" and os.path.basename(os.path.dirname(source)) == "s4":
            raise OSError("disk full (test)")
        if slow:
            time.sleep(0.003)
        return real_copy2(source, destination, *a, **k)

    def unlink(*a, **k):
        if slow:
            time.sleep(0.001)
        return real_unlink(*a, **k)

    def durable(source, destination):
        if slow:
            time.sleep(0.02)  # between the whole new file being written and it replacing the old one
        return real_durable(source, destination)

    os.replace, shutil_module.copyfile, shutil_module.copy2, os.unlink = replace, copyfile, copy2, unlink
    migration._replace_durably = durable
    migration.RENAME_RETRY_SECONDS = 0.05
    print("READY", flush=True)
    result = migration.run(data_dir, STEPS, account=ACCOUNT)
    print("RESULT " + json.dumps({"ok": (result or {}).get("ok"), "error": (result or {}).get("error")}), flush=True)


def start_child(data_dir: Path, mode: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-X", "utf8", __file__, "--child", str(data_dir), mode],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=str(ROOT))


def run_child(data_dir: Path, mode: str) -> dict:
    proc = start_child(data_dir, mode)
    out, _ = proc.communicate(timeout=120)
    lines = [line for line in out.splitlines() if line.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, f"the child failed: {out}"
    return json.loads(lines[-1][len("RESULT "):])


def where_it_stopped(data_dir: Path) -> str:
    layout = data_dir / ".layout"
    names = os.listdir(layout) if layout.is_dir() else []
    journal = layout / "journal.json"
    version = migration.layout_version(str(data_dir))
    if (layout / "journal.json.tmp").exists() and not journal.exists():
        return "writing the journal"
    if journal.exists():
        state = json.loads(journal.read_text(encoding="utf-8"))
        marks = {m["mark"] for m in state["moves"] if m.get("mark")}
        if state["state"] == "rolling-back":
            return "undoing a failed run"
        if version >= state["to_version"]:
            return "after layout.json, before the journal was put away"
        if marks & {"copying"}:
            return "copying an entry whose rename was refused"
        if marks & {"copied"}:
            return "clearing the old place after a checked copy"
        done = sum(1 for m in state["moves"] if os.path.lexists(data_dir / m["destination"]))
        return f"moving ({'none' if not done else 'some' if done < len(state['moves']) else 'all'} moved)"
    if any(n.endswith(".partial") for n in names):
        return "making the safety copy"
    if version >= FINAL:
        return "finished"
    if any(n.startswith("run-") for n in names):
        return "after the safety copy, before the journal"
    return "before the safety copy"


@unittest.skipUnless(junctions_work(), "kills and junctions are tested on Windows, where the app runs")
class Interruption(unittest.TestCase):
    """Kill the migration at random moments; the next start must always end consistent."""
    ROUNDS = int(os.getenv("KAIROS_KILL_ROUNDS", "40"))

    @classmethod
    def setUpClass(cls):
        cls.root = TemporaryDirectory(prefix="kairos-kill-", dir=tempfile.gettempdir())
        root = Path(cls.root.name)
        cls.outside = root / "outside"
        cls.template = root / "template"
        make_profile(cls.template, cls.outside)
        cls.expected = manifest(cls.template)
        cls.outside_before = manifest(cls.outside)
        cls.seen = {}

    @classmethod
    def tearDownClass(cls):
        print("\nWhere the kills landed:", file=sys.stderr)
        for mode, places in cls.seen.items():
            for place, count in sorted(places.items(), key=lambda kv: -kv[1]):
                print(f"  {mode:8} {count:3}  {place}", file=sys.stderr)
        cls.root.cleanup()

    def fresh(self, n: int) -> Path:
        data = Path(self.root.name) / f"data{n}"
        if data.exists():
            shutil.rmtree(data)
        migration._copy_tree(str(self.template), str(data))
        return data

    def check(self, data: Path, version: int) -> None:
        self.assertEqual(migration.layout_version(str(data)), version)
        self.assertFalse((data / ".layout" / "journal.json").exists(), "no run left half done")
        self.assertEqual(placed(data, version), {k: v for k, v in self.expected.items()}, "every file once, unchanged")
        leftovers = [n for n in os.listdir(data / ".layout") if n.endswith((".partial", ".tmp", ".zip"))]
        self.assertEqual(leftovers, [], "nothing unfinished left in .layout")
        self.assertLessEqual(len([n for n in os.listdir(data / ".layout") if n.startswith("run-")]), 1)
        self.assertEqual(manifest(self.outside), self.outside_before, "the junction's target was never touched")

    def kill_rounds(self, mode: str, final: int) -> None:
        started = time.monotonic()
        result = run_child(self.fresh(0), mode)  # how long an uninterrupted run takes
        duration = time.monotonic() - started
        self.check(Path(self.root.name) / "data0", final)
        self.assertEqual(bool(result["ok"]), final == FINAL, result)
        seen = self.seen.setdefault(mode, {})
        rng = random.Random(f"kairos-{mode}")
        for n in range(1, self.ROUNDS + 1):
            data = self.fresh(n)
            proc = start_child(data, mode)
            self.assertEqual(proc.stdout.readline().strip(), "READY")
            time.sleep(rng.uniform(0, duration))
            proc.kill()  # TerminateProcess: no cleanup runs, like stopBackend()
            proc.wait(timeout=30)
            proc.stdout.close()
            place = where_it_stopped(data)
            seen[place] = seen.get(place, 0) + 1
            with self.subTest(round=n, stopped=place):
                run_child(data, mode + "-fast")  # the next start
                self.check(data, final)
                again = run_child(data, mode + "-fast")  # and the one after
                self.check(data, final)
                if final == FINAL:
                    self.assertIsNone(again["ok"], "a start after the finished run has nothing to do")
            shutil.rmtree(data)
        if self.ROUNDS >= 20:
            self.assertGreaterEqual(len(seen), 5, f"the kills should land in many places: {seen}")

    def test_killed_anywhere_the_next_start_finishes_the_move(self):
        self.kill_rounds("slow", FINAL)

    def test_killed_anywhere_a_failing_run_is_always_undone(self):
        self.kill_rounds("failing", 0)


class SafetyNet(unittest.TestCase):
    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-net-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name) / "data"
        self.outside = Path(self.root.name) / "outside"
        make_profile(self.data, self.outside)
        self.before = manifest(self.data)

    def run_steps(self, **kwargs):
        return migration.run(str(self.data), STEPS, account=ACCOUNT, **kwargs)

    def test_the_safety_copy_keeps_the_stores_and_leaves_the_large_folders(self):
        phases = []
        real = startup_progress.update
        with patch.object(startup_progress, "update", lambda *a, **k: (phases.append(a[0] if a else k["phase"]), real(*a, **k))):
            result = self.run_steps()
        self.assertTrue(result["ok"], result)
        self.assertEqual([p for i, p in enumerate(phases) if i == 0 or phases[i - 1] != p],
                         ["checking", "safety", "moving", "finishing"], "progress said what it was doing")
        copies = Path(result["safety"]) / "copies"
        kept = {rel for rel in manifest(copies)}
        for rel in ("notes.json", "settings.json", "auth.json", "sessions.db", "sessions.db-wal", "sessions.db-shm",
                    "mobile_activity.db", "chats/c000.json", "skills/s0/meta.json"):
            self.assertIn(rel, kept)
        self.assertFalse([rel for rel in kept if rel.split("/")[0] in
                          ("generated_files", "attachments", "file_checkpoints", "logs", "vault")], kept)
        self.assertNotIn("documents/d0.md", kept, "only store files")
        self.assertEqual(manifest(copies)["notes.json"], self.before["notes.json"])
        self.assertEqual(manifest(Path(result["safety"]) / "copy-first" / "vault"),
                         {k[len("vault/"):]: v for k, v in self.before.items() if k.startswith("vault/")})
        record = json.loads((Path(result["safety"]) / "journal.json").read_text(encoding="utf-8"))
        self.assertEqual((record["state"], record["from_version"], record["to_version"]), ("done", 0, 2))
        self.assertEqual({m["name"] for m in record["moves"]}, MOVED)
        self.assertFalse((self.data / ".layout" / "journal.json").exists())
        self.assertEqual(placed(self.data, 2), self.before)

    def test_a_file_over_the_limit_is_only_renamed(self):
        with patch.object(migration, "SAFETY_MAX_FILE", 4000):
            result = self.run_steps()
        kept = manifest(Path(result["safety"]) / "copies")
        self.assertNotIn("sessions.db", kept, "5 KB is over this limit")
        self.assertIn("notes.json", kept)

    def test_revert_puts_the_old_layout_and_the_old_stores_back(self):
        result = self.run_steps()
        account = self.data / "accounts" / ACCOUNT
        (account / "notes.json").write_text("[changed by the new version]", encoding="utf-8")
        (self.data / "settings.json").write_text('{"new": true}', encoding="utf-8")
        os.remove(account / "sessions.db-wal")
        (account / "sessions.db-journal").write_text("stale", encoding="utf-8")
        (account / "google_accounts.json").write_text("{}", encoding="utf-8")  # made by the new version
        reverted = migration.revert(str(self.data))
        self.assertEqual((reverted["layout"], reverted["moved_back"]), (0, len(MOVED)))
        self.assertEqual(migration.layout_version(str(self.data)), 0)
        after = manifest(self.data)
        for rel in self.before:
            self.assertEqual(after.get(rel), self.before[rel], rel)
        self.assertFalse((self.data / "sessions.db-journal").exists())
        self.assertTrue((account / "google_accounts.json").exists(), "files the new version made stay")
        record = json.loads((Path(result["safety"]) / "journal.json").read_text(encoding="utf-8"))
        self.assertEqual(record["state"], "reverted")
        with self.assertRaises(ValueError):
            migration.revert(str(self.data))

    def test_a_run_cut_off_before_its_journal_is_cleared_and_started_again(self):
        # Found by the kill test: cut while the journal was being written, the next start found a finished
        # safety copy and no journal; its own safety copy, made in the same second, collided with it.
        layout = self.data / ".layout"
        stale = layout / "run-2-20261110-200000"
        (stale / "copies").mkdir(parents=True)
        (stale / "copies" / "notes.json").write_text("[1, 2]", encoding="utf-8")
        (layout / "journal.json.tmp").write_text('{"state": "mov', encoding="utf-8")
        (layout / "run-2-20261110-200001.partial").mkdir()
        result = self.run_steps()
        self.assertTrue(result["ok"], result)
        self.assertEqual(sorted(result["tidied"]), ["journal.json.tmp", "run-2-20261110-200000", "run-2-20261110-200001.partial"])
        self.assertEqual(sorted(n for n in os.listdir(layout) if n.startswith("run-")), [os.path.basename(result["safety"])])
        self.assertEqual(placed(self.data, 2), self.before)

    def test_cut_after_layout_json_the_next_start_only_puts_the_journal_away(self):
        result = self.run_steps()
        record = json.loads((Path(result["safety"]) / "journal.json").read_text(encoding="utf-8"))
        record["state"] = "moving"  # as it was the instant before the journal was put away
        (self.data / ".layout" / "journal.json").write_text(json.dumps(record), encoding="utf-8")
        again = self.run_steps()
        self.assertTrue(again["ok"] and again["resumed"], again)
        self.assertEqual(set(again["strategies"].values()), {"moved before"})
        self.assertFalse((self.data / ".layout" / "journal.json").exists())
        self.assertEqual(placed(self.data, 2), self.before)

    def test_a_data_folder_that_does_not_exist_yet_gets_its_layout(self):
        """2.3.0-beta.3's macOS build check imported the app with no data folder: layout.json.tmp had nowhere to go."""
        fresh = Path(self.root.name) / "not-made-yet" / "data"
        result = migration.run(str(fresh), STEPS, account=ACCOUNT)
        self.assertTrue(result["ok"])
        self.assertEqual(json.loads((fresh / "layout.json").read_text(encoding="utf-8"))["version"], FINAL)
        self.assertIsNone(migration.run(str(fresh), STEPS, account=ACCOUNT), "a second start has nothing to do")

    def test_a_later_start_has_nothing_to_do(self):
        self.assertTrue(self.run_steps()["ok"])
        self.assertIsNone(self.run_steps())

    def test_pending_says_whether_a_start_will_move_anything(self):
        empty = Path(self.root.name) / "empty"
        empty.mkdir()
        with patch.object(migration, "STEPS", STEPS):
            self.assertTrue(migration.pending(str(self.data)))
            self.run_steps()
            self.assertFalse(migration.pending(str(self.data)))
            (self.data / ".layout" / "journal.json").write_text("{}", encoding="utf-8")
            self.assertTrue(migration.pending(str(self.data)), "a cut-off run is carried on")


@unittest.skipUnless(junctions_work(), "Windows junctions")
class Junctions(unittest.TestCase):
    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-junction-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name) / "data"
        self.outside = Path(self.root.name) / "outside"
        make_profile(self.data, self.outside)
        self.link = self.data / "generated_files" / "run00" / "snapshot" / "node_modules"
        self.outside_before = manifest(self.outside)

    def test_a_junction_is_a_link_and_walks_never_enter_it(self):
        self.assertFalse(os.path.islink(self.link), "why this was missed: islink() is False for a junction")
        self.assertTrue(links.is_link(self.link))
        self.assertEqual(links.kind(str(self.link)), "junction")
        self.assertEqual(os.path.normcase(links.target(str(self.link))), os.path.normcase(str(self.outside / "node_modules")))
        walked = [os.path.join(folder, name) for folder, _, files, _ in links.walk(str(self.data)) for name in files]
        self.assertFalse([p for p in walked if "node_modules" in p])
        self.assertEqual(migration._sizes(str(self.link.parent)), {"node_modules": -2})

    def test_backup_records_the_junction_and_restore_makes_it_again(self):
        from core import backup
        with patch.object(backup, "_data_dir", lambda: str(self.data)):
            files = [rel for _, rel in backup._files(str(self.data))]
            self.assertFalse([rel for rel in files if "node_modules" in rel], "never packed through the junction")
            archive_path = Path(self.root.name) / "backup.zip"
            manifest_ = backup.make_backup(str(archive_path), include_keys=True)
            self.assertEqual(manifest_["links"], 1)
            with zipfile.ZipFile(archive_path) as archive:
                self.assertFalse([n for n in archive.namelist() if "node_modules" in n and n != backup.LINKS])
                rows = json.loads(archive.read(backup.LINKS))
            self.assertEqual([(r["path"], r["kind"]) for r in rows],
                             [("generated_files/run00/snapshot/node_modules", "junction")])
            backup.check_backup(str(archive_path))
            backup.stage_restore(str(archive_path))
            links.remove(str(self.link))
            result = backup.apply_pending_restore(str(self.data))
        self.assertTrue(result["ok"], result)
        self.assertNotIn("links_skipped", result)
        self.assertTrue(links.is_link(self.link), "made again as a junction")
        self.assertEqual(os.path.normcase(links.target(str(self.link))), os.path.normcase(str(self.outside / "node_modules")))
        self.assertEqual(manifest(self.outside), self.outside_before)

    def test_the_scratch_sweep_never_deletes_through_a_junction(self):
        # generated_files/scratch holds worktrees, and a worktree can hold a .venv junction: os.walk went
        # through it and removed every file older than two days in the junction's target.
        from core import image_gen
        scratch = self.data / "generated_files" / "scratch"
        (scratch / "old-run").mkdir(parents=True)
        old = time.time() - 10 * 86400
        (scratch / "old-run" / "stale.txt").write_text("old", encoding="utf-8")
        os.utime(scratch / "old-run" / "stale.txt", (old, old))
        (scratch / "worktree").mkdir()
        links.make(str(scratch / "worktree" / ".venv"), str(self.outside / "node_modules"), "junction")
        for path in (self.outside / "node_modules" / "pkg").iterdir():
            os.utime(path, (old, old))
        with patch.object(image_gen, "scratch_dir", lambda: str(scratch)):
            self.assertEqual(image_gen.sweep_scratch(), 1)
        self.assertFalse((scratch / "old-run").exists(), "the old scratch file and its emptied folder went")
        self.assertTrue(links.is_link(scratch / "worktree" / ".venv"))
        self.assertEqual(manifest(self.outside), self.outside_before, "nothing behind the junction was deleted")

    def test_a_backup_naming_a_link_outside_the_rules_is_refused(self):
        from core import backup
        bad = Path(self.root.name) / "bad.zip"
        with zipfile.ZipFile(bad, "w") as archive:
            archive.writestr(backup.MANIFEST, json.dumps({"version": backup.VERSION}))
            archive.writestr(backup.LINKS, json.dumps([{"path": "../escape", "target": "C:\\", "kind": "junction"}]))
        with self.assertRaises(backup.BackupRefused):
            backup.check_backup(str(bad))

    def test_a_copied_entry_keeps_its_junction_and_the_target_is_untouched(self):
        real = os.replace

        def refuse(source, destination, *a, **k):
            if os.path.basename(source) == "generated_files" and "accounts" in str(destination):
                raise PermissionError(13, "Access is denied", source)
            return real(source, destination, *a, **k)
        with patch.object(migration, "RENAME_RETRY_SECONDS", 0.05), patch.object(os, "replace", refuse):
            result = migration.run(str(self.data), STEPS, account=ACCOUNT)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["strategies"]["generated_files"], "copy")
        moved = self.data / "accounts" / ACCOUNT / "generated_files" / "run00" / "snapshot" / "node_modules"
        self.assertTrue(links.is_link(moved), "copied as a junction")
        self.assertFalse(self.link.exists() or os.path.lexists(self.link), "the old place is gone")
        self.assertEqual(manifest(self.outside), self.outside_before, "clearing the old place never went inside")
        kept = manifest(Path(result["safety"]) / "copies")
        self.assertFalse([rel for rel in kept if "node_modules" in rel])


class Progress(unittest.TestCase):
    def free_port(self) -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def get(self, port, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_the_port_answers_with_progress_and_is_handed_over(self):
        port = self.free_port()
        self.assertTrue(startup_progress.serve(port))
        self.addCleanup(startup_progress.stop)
        startup_progress.update("moving", "Moving your files into your account (chats)", 3, 12)
        code, body = self.get(port, "/api/health")
        self.assertEqual(code, 503, "anything waiting for a 200 keeps waiting")
        state = json.loads(body)
        self.assertEqual((state["status"], state["phase"], state["done"], state["total"]), ("updating", "moving", 3, 12))
        code, body = self.get(port, "/api/startup")
        self.assertEqual((code, json.loads(body)["detail"]), (200, "Moving your files into your account (chats)"))
        code, body = self.get(port, "/")
        self.assertEqual(code, 503)
        self.assertIn(b"Updating your data for this version", body)
        startup_progress.stop()
        # uvicorn opens the same port right after: it must be free at once.
        with socket.socket() as s:
            s.bind(("127.0.0.1", port))
            s.listen()

    def test_only_a_desktop_start_with_work_to_do_opens_the_port(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("APP_PORT", None)
            self.assertFalse(startup_progress.serve_if_needed(True, True))
        with patch.dict(os.environ, {"APP_PORT": str(self.free_port())}):
            self.assertFalse(startup_progress.serve_if_needed(False, False))
            self.assertTrue(startup_progress.serve_if_needed(False, True))
            startup_progress.stop()

    def test_app_opens_the_progress_answer_first_and_closes_it_last(self):
        source = (ROOT / "app.py").read_text(encoding="utf-8")
        self.assertLess(source.index("_startup_progress.serve_if_needed("), source.index("apply_pending_restore()"))
        self.assertLess(source.index("_account_migration.run()"), source.index("startup_progress.stop()"))
        self.assertLess(source.index("startup_progress.stop()"), source.index("        yield\n"),
                        "the port is handed to uvicorn only when start-up is done")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--child"]:
        child(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
