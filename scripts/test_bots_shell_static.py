"""Bots mode shell (Agents 3.0 Phase 0, unit U3): what can be proved from the files.

What these prove: every tab id the nav lists for Bots (and Forge) has a view
module; every CSS `[data-app-mode=...]` value in the stylesheets is one of the
three modes; Bots shell styles are scoped to Bots mode and use only tokens; the
phone sheet and tab bar know all three modes; the legacy `agents` tab and its
links are untouched (Phase 0 leaves them alone). No app or browser is started.
Run: python scripts/test_bots_shell_static.py
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
JS = REPO / "static" / "js"
CSS = REPO / "static" / "css"
MODES = {"kairos", "forge", "bots"}


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(source: str) -> str:
    return re.sub(r"/\*.*?\*/", "", source, flags=re.S)


def nav_ids(name: str) -> list:
    """The ids in `export const <name> = [ { id: '...' }, ... ];` of appModes.js."""
    block = re.search(rf"export const {name} = \[(.*?)\n\];", text(JS / "appModes.js"), flags=re.S)
    assert block, f"{name} not found in appModes.js"
    return re.findall(r"id:\s*'([^']+)'", block.group(1))


class BotsShellStaticTests(unittest.TestCase):
    def test_every_nav_tab_has_a_view_module(self):
        for name in ("BOTS_NAV", "FORGE_NAV"):
            ids = nav_ids(name)
            self.assertTrue(ids, name)
            for tab in ids:
                self.assertTrue((JS / "views" / f"{tab}.js").is_file(), f"{name}: no static/js/views/{tab}.js")

    def test_the_bots_page_tab_has_a_view_module_too(self):
        # botsShell is not a nav item (it is one bot's page) but modeForTab sends it to Bots.
        self.assertTrue((JS / "views" / "botsShell.js").is_file())
        self.assertIn("'botsShell'", text(JS / "appModes.js"))

    def test_views_export_render(self):
        for tab in ("botsHome", "botsShell"):
            self.assertRegex(text(JS / "views" / f"{tab}.js"), r"export async function render\(", tab)

    def test_every_data_app_mode_value_is_one_of_the_three_modes(self):
        found = {}
        for sheet in sorted(CSS.glob("*.css")):
            for value in re.findall(r'data-app-mode(?:[~|^$*]?=)"?([\w-]+)"?', strip_comments(text(sheet))):
                found.setdefault(sheet.name, set()).add(value)
        self.assertTrue(found)
        for sheet, values in found.items():
            self.assertLessEqual(values, MODES, f"{sheet}: {sorted(values - MODES)}")
        self.assertIn("bots", found.get("bots-shell.css", set()))

    def test_js_only_sets_or_reads_known_modes(self):
        for source in sorted(JS.glob("*.js")) + sorted((JS / "views").glob("*.js")):
            for value in re.findall(r"dataset\.appMode\s*===?\s*'([\w-]+)'", text(source)):
                self.assertIn(value, MODES, f"{source.name}: {value}")

    def test_bots_shell_styles_are_scoped_to_bots_mode_and_use_tokens(self):
        css = strip_comments(text(CSS / "bots-shell.css"))
        body = re.sub(r"@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", "", css)
        body = re.sub(r"@media[^{]*\{", "", body)
        selectors = re.findall(r"(?:^|[};])\s*([^{};@][^{};]*)\{", body)
        self.assertTrue(selectors)
        for selector in selectors:
            for part in re.split(r",(?![^(]*\))", selector):
                self.assertIn('data-app-mode="bots"', part, f"unscoped selector {part.strip()!r}")
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d", css), "a raw colour in bots-shell.css")
        # Everything it reads from the Bots tokens exists in bots.css.
        defined = set(re.findall(r"(--bots-[\w-]+)\s*:", text(CSS / "bots.css")))
        used = set(re.findall(r"var\((--bots-[\w-]+)", css))
        self.assertFalse(used - defined, f"undefined tokens: {sorted(used - defined)}")

    def test_the_phone_sheet_and_tab_bar_know_all_three_modes(self):
        sheet = text(JS / "mobileTabSheet.js")
        for mode in MODES:
            self.assertRegex(sheet, rf"\b{mode}: \{{ name:", f"mobileTabSheet MODES has no {mode}")
        bar = text(JS / "mobileTabBar.js")
        self.assertIn("ITEMS = { kairos: KAIROS, forge: FORGE, bots: BOTS }", bar)
        self.assertIn("'botsHome'", bar)
        # The thumb slides across three segments.
        mobile = text(CSS / "redesign-mobile.css")
        self.assertIn("repeat(3, minmax(0, 1fr))", mobile)
        self.assertIn("[data-active=bots] .ms-mode-thumb { transform: translateX(200%); }", mobile)

    def test_app_js_builds_the_switch_from_appmodes(self):
        app = text(JS / "app.js")
        self.assertIn("from './appModes.js'", app)
        self.assertIn("MODE_SWITCH", app)
        self.assertIn("mountBotsRail", app)
        self.assertIn("botsRailCleanup", app)

    def test_the_legacy_agents_tab_and_its_links_are_untouched(self):
        app = text(JS / "app.js")
        self.assertIn('{ id: "agents", label: "Agents", icon: "agents" }', app)
        # Notification, notch and push links still open the legacy tab (Phase 0 design, 3.4).
        self.assertGreaterEqual(app.count("tab: 'agents', agentId"), 2)
        self.assertIn("switchTab('agents', { agentId })", app)

    def test_phone_routing_needs_no_new_tab_id_rule(self):
        # phoneRoute leaves unknown tab ids alone, so botsHome and botsShell pass through unchanged.
        route = text(JS / "mobileShell.js").split("export function phoneRoute")[1].split("export function initMobileShell")[0]
        self.assertNotIn("bots", route)
        self.assertIn("return { tab, options };", route)

    def test_mode_copy_has_no_em_dash(self):
        for name in ("appModes.js", "botsRail.js", "botsPanelHost.js", "views/botsHome.js", "views/botsShell.js"):
            self.assertNotIn("—", text(JS / name), name)


if __name__ == "__main__":
    unittest.main()
