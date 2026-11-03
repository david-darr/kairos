"""Bots mode shell (Agents 3.0 Phase 0, unit U3): what can be proved from the files.

What these prove: every tab id the nav lists for Bots (and Forge) has a view
module; every CSS `[data-app-mode=...]` value in the stylesheets is one of the
three modes; Bots shell styles are scoped to Bots mode and use only tokens; the
phone sheet and tab bar know all three modes; the retired `agents` tab is out of
navigation while its links still reach Bots (Phase 1, unit U4). No app or browser
is started.
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

    def test_the_phone_sidebar_reaches_all_three_modes(self):
        # 2026-11-02: the sliding sidebar's Home, Forge and Bots rows switch modes; More has no mode switch.
        sidebar = text(JS / "mobileSidebar.js")
        for tab in ("go('home')", "go('forgeHome')", "go('botsHome')"):
            self.assertIn(tab, sidebar)
        sheet = text(JS / "mobileTabSheet.js")
        self.assertNotIn("ms-mode-switch", sheet)
        self.assertIn("openBotsList", sheet)
        self.assertIn("openBotsInbox", sheet)

    def test_app_js_builds_the_switch_from_appmodes(self):
        app = text(JS / "app.js")
        self.assertIn("from './appModes.js'", app)
        self.assertIn("MODE_SWITCH", app)
        self.assertIn("mountBotsRail", app)
        self.assertIn("botsRailCleanup", app)

    def test_the_retired_agents_tab_is_out_of_navigation_but_its_links_still_arrive(self):
        app = text(JS / "app.js")
        self.assertNotIn('{ id: "agents", label: "Agents", icon: "agents" }', app)
        # One boundary maps every old link (botsNavigation.js); app.js applies it before the mode and phone route.
        self.assertIn("normalizeBotsTarget('agents', options)", app)
        self.assertIn("notificationTarget(url, location.origin)", app)
        self.assertGreaterEqual(app.count("tab: 'botsShell', agentId"), 2, "desktop notification and notch chip open the bot directly")
        self.assertNotIn("switchTab('agents'", app)

    def test_bots_sidebar_styles_are_scoped_to_bots_mode_and_use_tokens(self):
        css = strip_comments(text(CSS / "bots-sidebar.css"))
        body = re.sub(r"@media[^{]*\{", "", css)
        selectors = re.findall(r"(?:^|[};])\s*([^{};@][^{};]*)\{", body)
        self.assertTrue(selectors)
        for selector in selectors:
            for part in re.split(r",(?![^(]*\))", selector):
                self.assertIn('data-app-mode="bots"', part, f"unscoped selector {part.strip()!r}")
        self.assertIsNone(re.search(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d", css), "a raw colour in bots-sidebar.css")
        defined = set(re.findall(r"(--bots-[\w-]+)\s*:", text(CSS / "bots.css")))
        used = set(re.findall(r"var\((--bots-[\w-]+)", css))
        self.assertFalse(used - defined, f"undefined tokens: {sorted(used - defined)}")

    def test_the_sidebar_loads_both_stylesheets_and_the_navigation_modules_are_pure(self):
        rail = text(JS / "botsRail.js")
        self.assertIn("/static/css/bots-sidebar.css", rail)
        for name in ("botsNavigation.js", "botsSidebarModel.js"):
            source = re.sub(r"^\s*//.*$", "", text(JS / name), flags=re.M)
            self.assertIsNone(re.search(r"^import ", source, flags=re.M), f"{name} must stay import-free so Node and the notch can load it")
            self.assertIsNone(re.search(r"\b(document|window|localStorage|fetch)\b", source), f"{name} touches the page")

    def test_phone_routing_needs_no_new_tab_id_rule(self):
        # phoneRoute leaves unknown tab ids alone, so botsHome and botsShell pass through unchanged.
        route = text(JS / "mobileShell.js").split("export function phoneRoute")[1].split("export function initMobileShell")[0]
        self.assertNotIn("bots", route)
        self.assertIn("return { tab, options };", route)

    def test_mode_copy_has_no_em_dash(self):
        for name in ("appModes.js", "botsRail.js", "botsPanelHost.js", "views/botsHome.js", "views/botsShell.js",
                     "botsNavigation.js", "botsSidebarModel.js", "botsThreadMenu.js", "views/agents.js", "agentCreation.js", "agentProfile.js"):
            self.assertNotIn("—", text(JS / name), name)

    def test_every_bots_link_into_settings_names_a_real_page(self):
        # A wrong id silently opens Appearance (views/settings.js openSettingsWindow), so a typo here is a dead button.
        pages = set(re.findall(r'\{\s*id:\s*"([a-z0-9-]+)",\s*label:', text(JS / "views" / "settings.js")))
        self.assertIn("computer-use", pages)
        links = []
        for path in JS.glob("bots*.js"):
            source = text(path)
            links += [(path.name, s) for s in re.findall(r"tab:\s*'settings',\s*section:\s*'([a-z0-9-]+)'", source)]
            links += [(path.name, s) for s in re.findall(r"go\('settings',\s*\{\s*section:\s*'([a-z0-9-]+)'", source)]
        onboarding = (REPO / "services" / "bot_onboarding.py").read_text(encoding="utf-8")
        links += [("bot_onboarding.py", s) for s in re.findall(r'one\("[a-z]+", "[^"]+", [^,]+, "([a-z0-9-]+)"\)', onboarding)]
        self.assertGreaterEqual(len(links), 8)
        self.assertEqual([link for link in links if link[1] not in pages], [])

    def test_no_bots_module_hands_a_bare_null_to_the_dom(self):
        # node.replaceChildren(a, cond ? b : null) prints "null" on the page (the Routines tab did); h() and el() skip it.
        pattern = re.compile(r"\.(?:replaceChildren|append|prepend)\([^;]*\?\s*[\w.]+\s*:\s*null\)")
        found = [(path.name, m.group(0)[:80]) for path in [*JS.glob("bots*.js"), *(JS / "views").glob("bots*.js")] for m in pattern.finditer(text(path))]
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
