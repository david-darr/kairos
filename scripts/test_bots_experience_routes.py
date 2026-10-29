"""Bots Phase 1, unit U4: the app's routing and retirement, proved from the real app.

What these prove, with no browser and no network:
  - the routers the Bots screens call are reachable on the real app (threads, folders,
    pins, inbox), and the Phase 1 routers (U1 /api/bot-chat, U5 /api/bot-attention) are
    registered ahead of the generic /api/agents routes whenever their module exists;
  - the fixed /api/agents paths ("inbox", "conversations", "presets", "defaults") are
    declared before the generic /{agent_id} route, so none is swallowed by it;
  - /api/notifications is still device enrollment, not the Bots feed;
  - every Bots route is admin-only (require_admin is somewhere in its dependencies);
  - the static mount serves the new sidebar and navigation assets, and answers no /api path;
  - the retired Agents tab is gone from navigation and its view is only a redirect.

Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_experience_routes.py
"""
import importlib.util
import logging
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tempfile

_DATA = tempfile.TemporaryDirectory(prefix="bots-routes-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
os.environ.pop("NO_COLOR", None)

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from core.auth import SESSION_COOKIE_NAME, auth_manager  # noqa: E402

logging.disable(logging.CRITICAL)
JS = ROOT / "static" / "js"
CSS = ROOT / "static" / "css"
PHASE1 = {"bot_chat_routes": "/api/bot-chat", "bot_attention_routes": "/api/bot-attention"}
# The sidebar's calls: a member and an anonymous caller must be refused on every one.
SIDEBAR = ("/api/agents/{agent_id}/threads", "/api/agents/{agent_id}/threads/{session_id}", "/api/agents/{agent_id}/threads/delete",
           "/api/agents/{agent_id}/folders", "/api/agents/{agent_id}/folders/order", "/api/agents/{agent_id}/folders/{folder_id}")


def client(user):
    c = TestClient(app)
    if user:
        c.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session(user))
    return c


def paths():
    """(method, template) in the order the app declares them (the schema keeps that order)."""
    return [(method.upper(), template) for template, item in app.openapi()["paths"].items() for method in item]


def position(method: str, template: str) -> int:
    try:
        return paths().index((method, template))
    except ValueError:
        raise AssertionError(f"no route {method} {template}") from None


class BotsRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("bob", "bob-password-1")
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        cls.member, cls.anon = client("bob"), client(None)

    def test_the_routes_the_sidebar_calls_are_on_the_app(self):
        wanted = [("GET", "/api/agents"), ("GET", "/api/agents/inbox"), ("GET", "/api/agents/conversations"),
                  ("POST", "/api/agents/conversations/{kind}/{ident}"),
                  ("GET", "/api/agents/{agent_id}/threads"), ("POST", "/api/agents/{agent_id}/threads"),
                  ("PATCH", "/api/agents/{agent_id}/threads/{session_id}"), ("POST", "/api/agents/{agent_id}/threads/delete"),
                  ("POST", "/api/agents/{agent_id}/folders"), ("PUT", "/api/agents/{agent_id}/folders/order"),
                  ("PATCH", "/api/agents/{agent_id}/folders/{folder_id}"), ("DELETE", "/api/agents/{agent_id}/folders/{folder_id}")]
        for method, template in wanted:
            position(method, template)

    def test_fixed_agent_paths_come_before_the_generic_agent_route(self):
        generic = position("GET", "/api/agents/{agent_id}")
        for template in ("/api/agents/inbox", "/api/agents/conversations", "/api/agents/presets", "/api/agents/defaults"):
            self.assertLess(position("GET", template), generic, f"{template} must be declared before /{{agent_id}}")

    def test_phase_one_routers_register_before_the_generic_agent_routes(self):
        listed = paths()
        first_agent = min(i for i, (_, t) in enumerate(listed) if t.startswith("/api/agents"))
        for module, prefix in PHASE1.items():
            if importlib.util.find_spec(f"routes.{module}") is None:
                continue  # Not merged into this tree yet; app.py skips it the same way.
            mine = [i for i, (_, t) in enumerate(listed) if t.startswith(prefix)]
            self.assertTrue(mine, f"{module} is in the tree but registers no {prefix} route")
            self.assertLess(max(mine), first_agent, f"{prefix} must be registered before /api/agents")

    def test_phase_one_routers_stay_inside_their_own_prefix(self):
        for module, prefix in PHASE1.items():
            if importlib.util.find_spec(f"routes.{module}") is None:
                continue
            router = importlib.import_module(f"routes.{module}").router
            for route in router.routes:
                self.assertTrue(route.path.startswith(prefix), f"{module}: {route.path} is outside {prefix}")
        # Device enrollment keeps its own meaning, and nothing of the Bots feed sits on its path.
        self.assertEqual([m for m, t in paths() if t == "/api/notifications"], ["GET"])

    def test_the_sidebars_routes_refuse_members_and_anonymous_callers(self):
        swept = 0
        for method, template in paths():
            if not (template in SIDEBAR or any(template.startswith(prefix) for prefix in PHASE1.values())):
                continue
            path = re.sub(r"\{[^}]+\}", "probe-id", template)
            for who, caller in (("member", self.member), ("anonymous", self.anon)):
                got = caller.request(method, path, json=None if method == "GET" else {})
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
            swept += 1
        self.assertGreaterEqual(swept, len(SIDEBAR))

    def test_the_static_mount_serves_the_new_assets_and_answers_no_api_path(self):
        client = TestClient(app)
        for asset in ("js/botsNavigation.js", "js/botsSidebarModel.js", "js/botsThreadMenu.js", "js/botsRail.js", "css/bots-sidebar.css"):
            response = client.get(f"/static/{asset}")
            self.assertEqual(response.status_code, 200, asset)
            self.assertGreater(len(response.text), 200, asset)
        mount = [route for route in app.router.routes if getattr(route, "path", "") == "/static"]
        self.assertEqual(len(mount), 1)
        self.assertGreater(app.router.routes.index(mount[0]), 10, "the static mount comes after the API routers")
        self.assertFalse([t for _, t in paths() if t.startswith("/static")], "no API route claims a static path")
        self.assertNotEqual(client.get("/static/api/agents").status_code, 200)

    def test_the_agents_tab_is_gone_from_navigation(self):
        app_js = (JS / "app.js").read_text(encoding="utf-8")
        nav = re.search(r"const NAV = \[(.*?)\n\];", app_js, flags=re.S).group(1)
        self.assertNotIn('id: "agents"', nav)
        self.assertNotIn("data-tab=\"agents\"", app_js)
        bar = (JS / "mobileTabBar.js").read_text(encoding="utf-8")
        self.assertNotIn("id: 'agents'", bar)
        self.assertNotIn("source: 'agents'", bar)
        self.assertIn("new Set(['home', 'chat', 'calendar', 'botsHome'])", (JS / "mobileTabSheet.js").read_text(encoding="utf-8"))
        self.assertNotIn("Agents", (JS / "redesignHome.js").read_text(encoding="utf-8").split("const DEFAULT_ORDER")[0])

    def test_the_old_agents_view_is_only_a_redirect(self):
        source = (JS / "views" / "agents.js").read_text(encoding="utf-8")
        self.assertLess(len(source.splitlines()), 40)
        self.assertIn("normalizeBotsTarget", source)
        for legacy in ("mountAgentChat", "mountAgentsMessenger", "mountComputerPanel", "routinesPanel", "agentEcosystem"):
            self.assertNotIn(legacy, source)
        for name in ("agentCreation.js", "agentProfile.js"):
            self.assertLess(len((JS / name).read_text(encoding="utf-8").splitlines()), 40, name)

    def test_app_routes_legacy_links_before_the_mode_and_phone_route(self):
        app_js = (JS / "app.js").read_text(encoding="utf-8")
        body = app_js.split("function switchTabNow(tabId, options) {")[1]
        legacy = body.index("routeLegacy(tabId, options)")
        self.assertLess(legacy, body.index("phoneRoute(tabId, options)"))
        self.assertLess(legacy, app_js.index("const mode = SHARED_TABS.has(tabId)"))
        # Notification links go through the one boundary, not their own parsing.
        self.assertIn("notificationTarget(url, location.origin)", app_js)
        self.assertNotIn("switchTab('agents'", app_js)


if __name__ == "__main__":
    unittest.main()
