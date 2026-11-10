"""Run only the tests that cover what changed (Changed-Only Tests, 2026-11-05).

    .venv\\Scripts\\python.exe -X utf8 scripts\\test_changed.py            run what the change touches
    .venv\\Scripts\\python.exe -X utf8 scripts\\test_changed.py --list     show the choice, run nothing
    .venv\\Scripts\\python.exe -X utf8 scripts\\test_changed.py --full     everything (the release gate)
    .venv\\Scripts\\python.exe -X utf8 scripts\\test_changed.py --refresh-coverage   re-record which files each UI unit loads

What changed: everything committed on this branch since it left `dev` (--base to choose another), plus
anything uncommitted. How it is matched:
- Python suites (scripts/test_*.py) by import graph: module-level imports all the way down, imports inside
  functions only when the test itself makes them, never through the hubs (app, core.tool_registry); and by
  naming a changed non-Python file.
- Node unit tests (scripts/test_*.cjs, test-*.cjs, test_*.mjs) by the files they load, followed through the
  front end's own imports (not through static/js/app.js).
- ui-smoke units (its --<area>-only flags and --bots-<name>-only checks) by recorded coverage: which app files
  each unit loaded (scripts/fixtures/ui-unit-coverage.json). Files every unit loads at start-up match by name
  (bots.css picks the Bots units), else the six CORE_UNITS; a file no unit loads gets the boot check only.
  STALE units (fail on unchanged dev, never in the full run) are skipped and named.
- The other Electron suites by their declared files (ELECTRON_SUITES below).
- A change to the test machinery runs every test of its kind (Python helpers: all Python suites; the Electron
  runners and fake backend: all of ui-smoke and the other Electron suites). A 4-second boot check always runs with any UI work.
Python changes never run ui-smoke: it runs on a fake backend written in JavaScript.
"""
import argparse
import ast
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PY = ROOT / ".venv" / "Scripts" / "python.exe"
COVERAGE = SCRIPTS / "fixtures" / "ui-unit-coverage.json"
LOCK = Path(os.environ.get("KAIROS_ELECTRON_LOCK") or (ROOT / "data" / "electron.lock"))
# A worktree shares the main checkout's Electron lock (Electron suites run one at a time per machine).
if "worktrees" in ROOT.parts:
    LOCK = Path(*ROOT.parts[:ROOT.parts.index("data")]) / "data" / "electron.lock"

# Changes to these run every test of their kind: they are how those tests run. (This runner itself is checked
# with --list on past commits; changing it runs nothing extra.)
UI_TOOLING = ["scripts/ui-smoke.cjs", "scripts/run-electron-test.cjs", "scripts/electron-exit.cjs", "demo/fixtures.js",
              "scripts/bots-check-support.cjs"]
PY_TOOLING = ["scripts/tab_test_support.py", "scripts/test_data_support.py"]


def python_suites():
    return [t for t in sorted(SCRIPTS.glob("test_*.py")) if t.name != "test_changed.py"]

# ui-smoke's own areas: unit name -> flag. Bots checks are added from the files.
UI_FLAGS = {"design": "--design-only", "google": "--google-only", "g3": "--g3-only", "agents-call": "--agents-call-only",
            "agents-ecosystem": "--agents-ecosystem-only", "agents-messenger": "--agents-messenger-only",
            "agents-layout": "--agents-layout-only", "agents-birth": "--agents-birth-only", "agents-phone": "--agents-phone-only",
            "mascot": "--mascot-only", "agents-profile": "--agents-profile-only", "interface": "--interface-only",
            "interface-details": "--interface-details-only", "mobile-chrome": "--mobile-chrome-only",
            "agents-appearance": "--agents-appearance-only", "app-shell": "--app-shell-only", "g8": "--g8-only",
            "g10": "--g10-only", "g1": "--g1-only", "g4": "--g4-only", "g4-calendar": "--g4-calendar-only", "g5": "--g5-only",
            "g6": "--g6-only", "a13-detail": "--a13-detail-only", "g7": "--g7-only", "a14-settings": "--a14-settings-only",
            "mobile": "--mobile-only", "mobile-shell": "--mobile-shell-only", "g2": "--g2-only",
            "chat-references": "--chat-references-only", "desktop-layout": "--desktop-layout-only", "home": "--home-only",
            "media-viewer": "--media-viewer-only"}
# Plain-language words for the units named after Part 2 groups, so file names can match them.
UNIT_WORDS = {"g1": "kip appearance home mascot", "g2": "chat composer attachments voice dictation artifact panes",
              "g3": "agents phone appearance village", "g4": "notes email", "g4-calendar": "calendar", "g5": "library documents vault",
              "g6": "tasks toolstore tool store cookbook", "g7": "settings", "g8": "admin settings users", "g10": "forge",
              "a13-detail": "toolstore tool store", "a14-settings": "settings", "interface": "interface composer drawers",
              "interface-details": "interface", "mobile-chrome": "mobile", "desktop-layout": "notes vault tasks",
              "media-viewer": "chat media viewer images video audio attachments artifact"}
SYNONYMS = {"agents": "bots", "agent": "bots", "bot": "bots", "frontdesk": "fdbot fdwork frontdesk kip", "kip": "frontdesk mascot",
            "redesign": "", "views": ""}

# The other Electron suites (run-electron-test.cjs names) and the files they exercise.
ELECTRON_SUITES = {
    "chat-smoke": ["static/js/views/chat.js", "static/js/chat*.js", "static/css/chat.css", "static/css/redesign-chat.css", "static/js/artifact*.js"],
    "chat-scroll-checks": ["static/js/views/chat.js", "static/js/chatScrollAnchor.js", "static/js/chatTimeline.js", "static/js/forgeTranscript.js",
                           "static/js/sessionChat.js", "static/js/sideChat.js", "static/css/chat.css", "scripts/cli_backend_fixture.py"],
    "chat-speed-checks": ["static/js/views/chat.js", "static/js/chatScrollAnchor.js", "static/js/botsComposer.js", "static/js/sessionChat.js",
                          "static/js/sideChat.js", "static/css/chat.css", "static/css/style.css", "static/css/bots-composer.css",
                          "scripts/cli_backend_fixture.py", "scripts/chat-speed-checks.cjs"],
    "mobile-tabs-checks": ["static/js/mobile*.js", "static/css/mobile*.css", "static/css/redesign-mobile.css", "scripts/mobile-tabs-checks.cjs"],
    "ask-user-checks": ["static/js/*question*.js", "static/js/*askUser*.js", "static/css/question-prompt.css", "scripts/ask-user-checks.cjs"],
    "browser-smoke": ["electron/browser.js", "electron/studio-prepare.js", "electron/studio-pages.js", "static/js/browserPane.js",
                      "scripts/browser-smoke.cjs", "scripts/fixtures/studio-mock/*"],
    "preview-smoke": ["electron/forgePreview.js", "static/js/forgeAppPreview.js", "scripts/preview-smoke.cjs"],
    "bg-tasks-smoke": ["static/js/backgroundTasks.js", "static/css/background-tasks.css", "routes/background_task_routes.py", "scripts/bg-tasks-smoke.cjs"],
    "crm-smoke": ["tabs/crm/*", "scripts/crm-smoke.cjs"],
    "usage-overlay-smoke": ["electron/usage-overlay*", "static/js/usage-overlay*.js", "static/css/usage-overlay*", "scripts/usage-overlay-smoke.cjs"],
    "roblox-smoke": ["tabs/roblox/*", "static/js/roblox*.js", "scripts/roblox-smoke.cjs"],
    "video-render-smoke": ["electron/designRender.js", "static/motion/*", "core/video_*.py", "core/ffmpeg_tools.py",
                           "core/design_render_bridge.py", "routes/video_routes.py", "scripts/video_render_smoke.py",
                           "scripts/video-render-smoke.cjs"],
    "studio-checks": ["tabs/studio/*", "static/motion/*", "static/js/studioEditor*.js", "static/js/studioTimeline.js", "static/js/studioSceneForm.js",
                      "static/css/studio-editor.css", "scripts/studio-checks.cjs"],
    "studio-content-checks": ["static/js/studioContent*.js", "static/css/studio-content.css", "static/css/studio-editor.css", "scripts/studio-content-checks.cjs"],
    "motion-engine-checks": ["static/motion/*", "scripts/motion-engine-checks.cjs"],
}


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout


def changed_files(base):
    if not base:
        base = git("merge-base", "HEAD", "dev").strip() or "HEAD"
    files = set(git("diff", "--name-only", f"{base}...HEAD").split())
    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].strip().strip('"')
        if " -> " in path:
            path = path.split(" -> ")[1]
        files.add(path.replace("\\", "/"))
    return sorted(f for f in files if f and not f.startswith(("data/", "docs/demo/", ".venv", "node_modules")))


# -- Python -----------------------------------------------------------------------------------------------------
def python_modules():
    mods = {}
    for folder in ("core", "services", "routes", "mcp_servers", "scripts", "tabs"):
        for path in (ROOT / folder).rglob("*.py"):
            if any(part in ("__pycache__", "node_modules") for part in path.parts):
                continue
            rel = path.relative_to(ROOT).with_suffix("")
            name = ".".join(rel.parts[:-1] if rel.name == "__init__" else rel.parts)
            mods[name] = path
    mods["app"] = ROOT / "app.py"
    return mods


def imports_of(path, mods):
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return set(), set()
    top, lazy = set(), set()
    package = ".".join(path.relative_to(ROOT).with_suffix("").parts[:-1])
    inside = set()  # nodes inside a function: imported only when that function runs
    for fn in ast.walk(tree):
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            inside.update(id(n) for n in ast.walk(fn) if n is not fn)
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                parts = package.split(".")[: len(package.split(".")) - node.level + 1] if package else []
                module = ".".join([p for p in parts if p] + ([module] if module else []))
            names = [module] + [f"{module}.{a.name}" for a in node.names]
        elif isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "import_module" and node.args and isinstance(node.args[0], ast.Constant):
            names = [str(node.args[0].value)]
        for name in names:
            while name:
                if name in mods:
                    (lazy if id(node) in inside or isinstance(node, ast.Call) else top).add(name)
                    break
                name = name.rpartition(".")[0]
    return top, lazy - top


# Modules that import nearly everything (the app, the tool registry): a test that reaches a change only through one
# of them is not testing it, so the search does not pass through them.
PY_HUBS = {"app", "core.tool_registry"}
JS_HUBS = {"static/js/app.js"}


def reach(start, top, lazy, hubs):
    """What `start` loads: module-level imports all the way down, plus what the test itself imports inside its
    functions. Imports inside the app's own functions run on some paths only; following them connects every
    module to every other (core.permissions lazily loads the routine runner, so every chat test "used" it)."""
    seen, stack = set(), [start, *lazy.get(start, ())]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if current in hubs and current != start:
            continue
        stack.extend(top.get(current, ()))
    return seen


def python_tests(changed):
    mods = python_modules()
    edges = {name: imports_of(path, mods) for name, path in mods.items()}
    top = {n: e[0] for n, e in edges.items()}
    lazy = {n: e[1] for n, e in edges.items()}
    changed_mods = {name for name, path in mods.items() if path.relative_to(ROOT).as_posix() in changed}
    chosen = {}
    for test in python_suites():
        seen = reach(f"scripts.{test.stem}", top, lazy, PY_HUBS)
        why = sorted(changed_mods & seen)
        text = None
        for f in changed:
            if f.endswith(".py"):
                continue
            text = text if text is not None else test.read_text(encoding="utf-8", errors="replace")
            if f in text or Path(f).name in text and len(Path(f).stem) > 6 and Path(f).stem not in ("index", "manifest", "README"):
                why.append(f)
        if f"scripts/{test.name}" in changed:
            why.append("the test itself")
        if why:
            chosen[test.name] = why
    return chosen


# -- Node unit tests -------------------------------------------------------------------------------------------
JS_IMPORT = re.compile(r"""(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]""")
FILE_REF = re.compile(r"""['"`]([\w./@-]+\.(?:m?js|cjs|css|json|py|html))['"`]""")


def js_graph():
    graph = {}
    for path in list((ROOT / "static").rglob("*.js")) + list((ROOT / "tabs").rglob("*.js")) + list((ROOT / "demo").rglob("*.js")):
        if "vendor" in path.parts or "node_modules" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        deps, lazy = set(), set()
        for match in JS_IMPORT.finditer(text):
            spec = match.group(1)
            if spec.startswith("."):
                target = (path.parent / spec).resolve()
                spec = target.relative_to(ROOT).as_posix() if target.is_relative_to(ROOT) else spec
            elif spec.startswith("/static/"):
                spec = spec.lstrip("/")
            else:
                continue
            (lazy if match.group(0).lstrip().startswith("import(") or "import (" in match.group(0) else deps).add(spec)
        graph[rel] = (deps, lazy - deps)
    return graph


def node_tests(changed):
    graph = js_graph()
    top = {k: v[0] for k, v in graph.items()}
    lazy = {k: v[1] for k, v in graph.items()}
    by_name = {}
    for rel in graph:
        by_name.setdefault(Path(rel).name, []).append(rel)
    chosen = {}
    tests = sorted(set(SCRIPTS.glob("test_*.cjs")) | set(SCRIPTS.glob("test-*.cjs")) | set(SCRIPTS.glob("test_*.mjs")))
    for test in tests:
        text = test.read_text(encoding="utf-8", errors="replace")
        refs = set()
        for ref in FILE_REF.findall(text) + JS_IMPORT.findall(text):
            clean = ref.lstrip("./").replace("../", "")
            if (ROOT / clean).exists():
                refs.add(clean)
            for rel in by_name.get(Path(ref).name, []):
                refs.add(rel)
        seen = set()
        for ref in refs:
            seen |= reach(ref, top, lazy, JS_HUBS)
        why = sorted(set(changed) & seen)
        if f"scripts/{test.name}" in changed:
            why.append("the test itself")
        if why:
            chosen[test.name] = why
    return chosen


# -- UI ---------------------------------------------------------------------------------------------------------
# Area checks that only run through their own flag (the full ui-smoke run never calls them) and fail on unchanged
# `dev`: never picked until fixed; --list names them when a change touches their area. Empty since 2026-11-10
# (fix/test-bar): g3 and interface were brought up to date; mobile, mobile-chrome, g8, g10, a14-settings, g6 and
# g7 pass on dev again (fixed by later work).
STALE = {}


def ui_units():
    units = {k: v for k, v in UI_FLAGS.items() if k not in STALE}
    for check in sorted(SCRIPTS.glob("bots-*-checks.cjs")):
        name = check.name[len("bots-"):-len("-checks.cjs")]
        units[f"bots-{name}"] = f"--bots-{name}-only"
    return units


def words(text):
    parts = re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", text).lower())
    out = set()
    for part in parts:
        if len(part) >= 4:
            out.add(part)
            out.update(SYNONYMS.get(part, "").split())
    return out


def unit_words(name):
    return words(name) | set(UNIT_WORDS.get(name, "").split())


# A file every screen loads at start (app.js, slashCommands.js, style.css) could break any screen. Rather than the
# whole run, these core screens check it (about 2 minutes); the release gate runs the rest.
CORE_UNITS = ["app-shell", "interface-details", "home", "desktop-layout", "mobile-shell", "chat-references"]


def ui_selection(changed, units, coverage):
    boot = set(coverage.get("_boot", []))
    known = set(coverage.get("_files", []))  # every front-end file when the map was recorded
    chosen = {}
    def add(unit, why):
        chosen.setdefault(unit, []).append(why)
    for f in changed:
        if f in UI_TOOLING:
            return {u: [f"{f} (test machinery)"] for u in units}, True
        if f.startswith("scripts/"):
            m = re.fullmatch(r"scripts/bots-(.+)-checks\.cjs", f)
            if m and f"bots-{m.group(1)}" in units:
                add(f"bots-{m.group(1)}", "the check itself")
            elif f.startswith("scripts/fixtures/bots-") and f.endswith("-backend.cjs"):
                for u in units:
                    if u.startswith("bots-"):
                        add(u, f)
            elif f.endswith("-checks.cjs"):
                text = (ROOT / "scripts" / "ui-smoke.cjs").read_text(encoding="utf-8")
                for u, flag in units.items():
                    block = text.split(f"'{flag}'", 1)[1][:1500] if f"'{flag}'" in text else ""
                    if Path(f).name in block:
                        add(u, "the check itself")
            continue
        if not f.startswith(("static/", "tabs/", "demo/")):
            continue
        users = [u for u, files in coverage.items() if u in units and f in files]
        near = [u for u in units if words(Path(f).stem) & unit_words(u)]
        if f in boot:
            for u in near or [u for u in CORE_UNITS if u in units]:
                add(u, f + (" (loaded at start; by name)" if near else " (loaded at start: the core screens)"))
        elif users:
            for u in users:
                add(u, f)
        elif coverage and f in known:
            add("boot", f + " (no ui-smoke unit loads it: the boot check only)")
        elif near:
            for u in near:
                add(u, f + (" (new since the coverage map; by name)" if coverage else " (no coverage map yet; by name)"))
        else:
            add("boot", f + " (no coverage and no name match: the boot check only)")
    return chosen, False


# Electron suites that fail on unchanged `dev`; skipped and named until fixed. Empty since 2026-11-10: roblox-smoke
# (a stale shared read in the Roblox tab) and bg-tasks-smoke (its harness hashed the whole checkout) are fixed.
STALE_SUITES = {}


def electron_selection(changed):
    chosen = {}
    for suite, globs in ELECTRON_SUITES.items():
        if suite in STALE_SUITES:
            continue
        hits = [f for f in changed if any(fnmatch.fnmatch(f, g) for g in globs)]
        if hits or any(f in UI_TOOLING for f in changed):
            chosen[suite] = hits or ["test machinery"]
    return chosen


# -- running ----------------------------------------------------------------------------------------------------
def run(cmd, timeout=1800):
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                           env={**os.environ, "PYTHONUTF8": "1"})
        code, out = r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        code, out = "timeout", ""
    return code, out, round(time.time() - t0, 1)


def take_lock():
    # 2026-11-10: owner.json names this process, so run-electron-test.cjs can tell a live
    # lock from one left by a killed run (it clears the latter).
    for _ in range(720):
        try:
            LOCK.mkdir(parents=True, exist_ok=False)
            (LOCK / "owner.json").write_text(json.dumps({"pid": os.getpid(), "started": time.strftime("%Y-%m-%dT%H:%M:%S")}), encoding="utf-8")
            return True
        except FileExistsError:
            time.sleep(5)
    return False


def release_lock():
    # Someone may already have cleared it; that must not crash the summary.
    shutil.rmtree(LOCK, ignore_errors=True)


def electron(args, timeout=2400):
    # 2026-11-10: this script already holds the lock, so the runner must not wait on it.
    # Without this flag every Electron run here waited forever on its own parent's lock.
    os.environ["JARVIS_ELECTRON_LOCK_HELD"] = "1"
    if args[0] == "bg-tasks-smoke":
        return bg_tasks(args[1:], timeout)
    return run(["node", "scripts/run-electron-test.cjs", *args], timeout)


def bg_tasks(extra, timeout):
    """bg-tasks-smoke runs against its scripted backend (bg_tasks_scripted.py), whose last startup line is JSON
    naming the port, session and data folder."""
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    t0 = time.time()
    harness = subprocess.Popen([str(PY), "-X", "utf8", "scripts/bg_tasks_scripted.py", "--port", str(port)], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    try:
        start, seen = None, []
        while start is None and time.time() - t0 < 120:
            line = harness.stdout.readline()
            if not line:
                break
            seen.append(line)
            if line.lstrip().startswith("{") and '"sessionId"' in line:
                start = json.loads(line)
        if start is None:
            return 1, "bg_tasks_scripted.py gave no startup line:\n" + "".join(seen[-30:]), round(time.time() - t0, 1)
        import threading  # keep reading its log so a full pipe never stalls it
        threading.Thread(target=lambda: seen.extend(harness.stdout), daemon=True).start()
        code, out, _ = run(["node", "scripts/run-electron-test.cjs", "bg-tasks-smoke", f"--bg-url=http://127.0.0.1:{port}",
                            f"--bg-session={start['sessionId']}", f"--bg-data-dir={start['dataDir']}",
                            f"--surface={start['surface']}", *extra], timeout)
        return code, out, round(time.time() - t0, 1)
    finally:
        harness.terminate()
        try:
            harness.wait(15)
        except subprocess.TimeoutExpired:
            harness.kill()


def refresh_coverage(units):
    out = {}
    tmp = ROOT / "data" / "ui-coverage"
    tmp.mkdir(parents=True, exist_ok=True)
    if not take_lock():
        sys.exit("The Electron lock stayed taken for an hour.")
    try:
        for name, flag in [("_boot", "--boot-only"), *units.items()]:
            file = tmp / f"{name}.json"
            file.unlink(missing_ok=True)
            code, text, secs = electron(["ui-smoke", flag, f"--record-coverage={file}"])
            files = json.loads(file.read_text(encoding="utf-8")) if file.exists() else []
            out[name] = files
            print(f"{'ok  ' if code == 0 else 'FAIL'} {name:24} {secs:6}s {len(files):4} files", flush=True)
    finally:
        release_lock()
    out["_files"] = sorted(f for f in git("ls-files", "static", "tabs", "demo", "docs").split() if not f.startswith("docs/demo/"))
    COVERAGE.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", COVERAGE.relative_to(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="compare against this commit (default: where the branch left dev)")
    parser.add_argument("--commit", help="judge one commit's files instead (with --list, to see what it would have run)")
    parser.add_argument("--list", action="store_true", help="show the choice and run nothing")
    parser.add_argument("--full", action="store_true", help="run everything")
    parser.add_argument("--refresh-coverage", action="store_true", help="re-record which files each ui-smoke unit loads")
    parser.add_argument("--no-ui", action="store_true", help="skip Electron suites")
    args = parser.parse_args()
    units = ui_units()
    if args.refresh_coverage:
        return refresh_coverage(units)
    coverage = json.loads(COVERAGE.read_text(encoding="utf-8")) if COVERAGE.exists() else {}
    changed = (sorted(f for f in git('show', '--name-only', '--format=', args.commit).split() if not f.startswith(('docs/demo/', 'data/')))
               if args.commit else changed_files(args.base))
    if args.full:
        py = {t.name: ["--full"] for t in python_suites()}
        node = {t.name: ["--full"] for t in sorted(set(SCRIPTS.glob("test_*.cjs")) | set(SCRIPTS.glob("test-*.cjs")) | set(SCRIPTS.glob("test_*.mjs")))}
        ui, full_ui, other = {}, True, {s: ["--full"] for s in ELECTRON_SUITES}
    else:
        py, node = python_tests(changed), node_tests(changed)
        ui, full_ui = ui_selection(changed, units, coverage)
        other = electron_selection(changed)
        if any(f in PY_TOOLING for f in changed):
            py = {t.name: ["test machinery"] for t in python_suites()}
    demo = any(f.startswith(("static/", "tabs/")) for f in changed)
    ui_work = bool(ui or other or full_ui)
    print(f"{len(changed)} changed file(s)" + ("" if args.full else ": " + ", ".join(changed[:12]) + (" ..." if len(changed) > 12 else "")))
    print(f"Python suites: {len(py)}   Node tests: {len(node)}   ui-smoke: {'the full run' if full_ui else str(len([u for u in ui if u != 'boot'])) + ' unit(s)'}"
          f"   other Electron suites: {len(other)}   boot check: {'yes' if ui_work else 'no'}   site demo: {'rebuild and test' if demo else 'no'}")
    for title, picks in (("Python", py), ("Node", node), ("ui-smoke", {} if full_ui else ui), ("Electron", other)):
        for name, why in picks.items():
            print(f"  {title:9} {name:40} {'; '.join(why)[:110]}")
    stale = sorted(u for u in STALE if not full_ui and any(words(Path(f).stem) & unit_words(u) for f in changed
                                                         if f.startswith(("static/", "tabs/", "demo/"))))
    for u in stale:
        print(f"  skipped   {u:40} stale check, fails on dev: {STALE[u]}"[:200])
    for suite in STALE_SUITES:
        if any(f in UI_TOOLING or any(fnmatch.fnmatch(f, g) for g in ELECTRON_SUITES[suite]) for f in changed):
            print(f"  skipped   {suite:40} stale suite, fails on dev: {STALE_SUITES[suite]}"[:200])
    if not coverage and ui and not full_ui:
        print("  note: no coverage map yet; run --refresh-coverage once (UI picks are by name until then)")
    if args.list:
        return
    t0, failures = time.time(), []
    with ThreadPoolExecutor(3) as pool:
        jobs = [(n, pool.submit(run, [str(PY), "-X", "utf8", f"scripts/{n}"])) for n in py]
        jobs += [(n, pool.submit(run, ["node", "--experimental-vm-modules", f"scripts/{n}"])) for n in node]
        for name, job in jobs:
            code, out, secs = job.result()
            print(f"{'ok  ' if code == 0 else 'FAIL'} {name:44} {secs:6}s", flush=True)
            if code != 0:
                failures.append((name, out[-1500:]))
    if demo:
        for cmd, name in (([str(PY), "-X", "utf8", "scripts/build_site_demo.py"], "site demo rebuild"),
                          ([str(PY), "-X", "utf8", "scripts/test_site_demo.py"], "test_site_demo.py"),
                          (["node", "scripts/test_site_demo_live.cjs"], "test_site_demo_live.cjs")):
            code, out, secs = run(cmd)
            print(f"{'ok  ' if code == 0 else 'FAIL'} {name:44} {secs:6}s", flush=True)
            if code != 0:
                failures.append((name, out[-1500:]))
    if ui_work and not args.no_ui:
        if not take_lock():
            sys.exit("The Electron lock stayed taken for an hour.")
        try:
            plan = [("boot", ["ui-smoke", "--boot-only"])]
            if full_ui:
                plan.append(("ui-smoke (full)", ["ui-smoke"]))
            else:
                plan += [(u, ["ui-smoke", units[u]]) for u in ui if u in units]
            plan += [(s, [s]) for s in other]
            for name, cmd in plan:
                code, out, secs = electron(cmd)
                print(f"{'ok  ' if code == 0 else 'FAIL'} {name:44} {secs:6}s", flush=True)
                if code != 0:
                    failures.append((name, out[-1500:]))
        finally:
            release_lock()
    print(f"\n{'PASS' if not failures else 'FAIL'}: {len(failures)} failure(s) in {round((time.time() - t0) / 60, 1)} min")
    for name, out in failures:
        print(f"\n--- {name}\n{out}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
