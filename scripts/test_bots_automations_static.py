"""Bots Phase 3, unit U3: the Automations page, editors and calendar hold together (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md sections 7 and 8 (U3).

What these prove, with no app or browser started:
  - every file the unit owns exists, and every relative import and every stylesheet it names resolves
  - the entry points other units rely on are exported under their agreed names
    (openRoutineEditor and openTriggerEditor for U5's change card; render for the view; mount for the sections)
  - every icon the modules draw is in botsIcons.js
  - every API path the modules call is one the design's section 6 names (or the existing trigger and agent routes)
  - the stylesheets hold no raw colour and scope every rule to [data-app-mode="bots"]
  - nothing user-facing carries OpenMausBot, MausBot, OpenDuet or Duet, or an em-dash
Run: python scripts/test_bots_automations_static.py
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STATIC = REPO / "static"
JS = STATIC / "js"
CSS = STATIC / "css"

OWNED_JS = [
    "views/botsAutomations.js", "botsSectionRoutines.js", "botsAutomationModel.js", "botsAutomationEditor.js",
    "botsAutomationCalendar.js", "botsAutomationEvents.js", "botsLimitReset.js",
]
OWNED_CSS = ["bots-automations.css", "bots-automation-calendar.css"]
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d")

# Section 6 of the design, plus the routes this unit reuses (agents, threads, the existing triggers, the chat start).
ROUTE_PATTERNS = [
    r"^/api/bot-automations$",
    r"^/api/bot-routines(/\{\}(/(run|defer))?|/preview)?$",
    r"^/api/bot-routine-runs/(\{\}/(cancel|seen)|seen-all)$",
    r"^/api/bot-limit-resets(/(after-reset|continue))?$",
    r"^/api/bot-app-triggers(/events|/\{\}(/(test|restore|sync))?)?$",
    r"^/api/bot-webhooks/\{\}/(address|attempts|capture|test|rotate|restore)$",
    r"^/api/bot-automation-changes/\{\}/undo$",
    r"^/api/triggers(/\{\})?$",
    r"^/api/agents$",
    r"^/api/agents/\{\}/threads$",
]


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def top_level_parts(selector: str) -> list[str]:
    """Split a selector list on the commas outside parentheses (:is(a, b) stays whole)."""
    parts, depth, current = [], 0, ""
    for ch in selector:
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    return parts + [current]


def scoped(selector: str) -> bool:
    return all(part.strip().startswith('[data-app-mode="bots"]') for part in top_level_parts(selector))


def js_files():
    return [JS / name for name in OWNED_JS]


class AutomationsStaticTests(unittest.TestCase):
    def test_every_owned_file_exists(self):
        missing = [str(p.relative_to(STATIC)) for p in js_files() + [CSS / n for n in OWNED_CSS] if not p.is_file()]
        self.assertEqual(missing, [])

    def test_relative_imports_and_stylesheets_resolve(self):
        problems = []
        for path in js_files():
            source = text(path)
            for match in re.finditer(r"""(?:from\s+|import\s*\(\s*)['"](\.{1,2}/[^'"]+)['"]""", source):
                target = (path.parent / match.group(1)).resolve()
                if not target.is_file():
                    problems.append(f"{path.name}: import {match.group(1)}")
            for match in re.finditer(r"""['"](/static/[^'"]+)['"]""", source):
                if not (REPO / match.group(1).lstrip("/")).is_file():
                    problems.append(f"{path.name}: {match.group(1)}")
        self.assertEqual(problems, [])

    def test_the_agreed_entry_points_are_exported(self):
        editor = text(JS / "botsAutomationEditor.js")
        for name in ("openRoutineEditor", "openTriggerEditor", "openWebhookEditor", "openAppEventEditor"):
            self.assertRegex(editor, rf"export (?:function|const) {name}\b", name)
        # U5's change card reads these names off the module.
        self.assertRegex(editor, r"openRoutineEditor\(\{\s*id\s*=\s*''")
        self.assertRegex(editor, r"openTriggerEditor\(\{\s*id\s*=\s*''")
        self.assertRegex(text(JS / "views" / "botsAutomations.js"), r"export async function render\(container, tabId, options")
        for name in ("botsSectionRoutines.js", "botsLimitReset.js"):
            self.assertRegex(text(JS / name), r"export async function mount\(host, ctx", name)
        self.assertRegex(text(JS / "botsAutomationCalendar.js"), r"export function mountCalendar\(host, ctx\)")

    def test_every_icon_exists(self):
        icons = set(re.findall(r"^\s*'([a-z0-9-]+)':", text(JS / "botsIcons.js"), re.M))
        used = set()
        for path in js_files():
            used |= set(re.findall(r"""(?:icon|iconName:|iconName =)\s*\(?\s*['"]([a-z0-9-]+)['"]""", text(path)))
            used |= set(re.findall(r"""iconName:\s*'([a-z0-9-]+)'""", text(path)))
        self.assertTrue(used, "the scan found no icons")
        self.assertEqual(sorted(used - icons), [])

    def test_every_api_path_is_in_the_design(self):
        unknown = []
        found = 0
        for path in js_files():
            for match in re.finditer(r"""`(/api/[^`]*)`|'(/api/[^']*)'""", text(path)):
                route = re.sub(r"\$\{(?:[^{}]|\{[^{}]*\})*\}", "{}", match.group(1) or match.group(2))
                route = re.sub(r"(?<=[a-z])\{\}$", "", route)  # a query string built apart from the path
                route = route.split("?")[0]
                found += 1
                if not any(re.match(pattern, route) for pattern in ROUTE_PATTERNS):
                    unknown.append(f"{path.name}: {route}")
        self.assertGreater(found, 20)
        self.assertEqual(sorted(set(unknown)), [])

    def test_no_raw_colour_in_the_unit(self):
        found = []
        for path in js_files() + [CSS / n for n in OWNED_CSS]:
            for number, line in enumerate(text(path).splitlines(), 1):
                if line.lstrip().startswith(("//", "/*", "*")):
                    continue
                if COLOR.search(line):
                    found.append(f"{path.name}:{number}: {line.strip()[:100]}")
        self.assertEqual(found, [], "use a --bots-* token")

    def test_every_css_rule_is_scoped_to_bots_mode(self):
        loose = []
        for name in OWNED_CSS:
            source = re.sub(r"/\*.*?\*/", "", text(CSS / name), flags=re.S)
            depth, start = 0, 0
            for index, ch in enumerate(source):
                if ch == "{":
                    if depth == 0:
                        selector = source[start:index].strip()
                        if selector and not selector.startswith("@") and not scoped(selector):
                            loose.append(f"{name}: {selector[:80]}")
                    elif depth == 1 and source[start:index].strip():
                        pass
                    depth += 1
                    start = index + 1
                elif ch == "}":
                    depth -= 1
                    start = index + 1
                elif ch == ";" and depth == 0:
                    start = index + 1
            # Rules inside @media are checked below.
            for block in re.finditer(r"@media[^{]*\{(.*?)\n\}", source, re.S):
                for selector in re.findall(r"(?:^|\})\s*([^{}@]+?)\s*\{", block.group(1)):
                    if not scoped(selector):
                        loose.append(f"{name} (media): {selector[:80]}")
        self.assertEqual(loose, [])

    def test_the_stylesheets_keep_motion_and_focus_rules(self):
        page = text(CSS / "bots-automations.css")
        self.assertIn(":focus-visible", page)
        # Reduced motion is switched off for every Bots surface in bots.css; these sheets add animation only through its names.
        self.assertNotRegex(page, r"@keyframes")
        self.assertNotRegex(text(CSS / "bots-automation-calendar.css"), r"@keyframes")

    def test_no_other_products_names_and_no_em_dashes(self):
        bad = re.compile(r"open\s*maus|mausbot|open\s*duet|duet|\bomb\b", re.I)
        problems = []
        for path in js_files() + [CSS / n for n in OWNED_CSS]:
            for number, line in enumerate(text(path).splitlines(), 1):
                stripped = line.strip()
                comment = stripped.startswith(("//", "/*", "*"))
                if not comment:
                    line = re.sub(r"\s//.*$", "", line)  # a trailing source comment may cite the spec
                # Source comments may cite the spec's reference ("OMB F55") as the design does; user-facing strings may not.
                if "—" in text(path).splitlines()[number - 1]:
                    problems.append(f"{path.name}:{number}: em-dash")
                if not comment and bad.search(line):
                    problems.append(f"{path.name}:{number}: {stripped[:80]}")
        self.assertEqual(problems, [])

    def test_the_view_is_a_bots_mode_view_and_the_page_is_not_registered_here(self):
        # Registering the page in the Bots nav and appModes belongs to Phase 1 unit U4: the hook is reported, not made.
        modes = text(JS / "appModes.js")
        self.assertNotIn("botsAutomations", modes, "this unit does not edit appModes.js; the orchestrator lists the hook")


if __name__ == "__main__":
    unittest.main()
