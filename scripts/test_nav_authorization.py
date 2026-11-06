"""Every surface the UI hides from non-admins is also refused by the server.

The list is read from the source on each run, so a new admin panel is covered
without editing this file: Settings groups and sections marked `admin: true`
(static/js/views/settings.js) and Home's admin-only reads
(static/js/views/home.js). Each API path those surfaces call is matched to the
real app's route and method; a member must get 401/403 on every method, and an
admin must not be refused on reads. Mutations are never sent as an admin.

    .venv\\Scripts\\python.exe scripts\\test_nav_authorization.py
"""
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix=".tab-test-navauth-", dir=str(ROOT / "scripts"))
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

from fastapi.testclient import TestClient
from starlette.routing import compile_path

from app import app
from core.auth import SESSION_COOKIE_NAME, auth_manager

# Used by member-visible surfaces too, so a member may legitimately read them.
SHARED = {"/api/sessions", "/api/auth/status"}
# Called by an admin-only surface, but member-safe by design (checked 2026-10-27).
MEMBER_OK = {
    ("GET", "/api/computer"): "lists only computers the member's own chats own (_access per item)",
    ("POST", "/api/computer/{owner}/stop"): "_access refuses other owners and every agent computer",
    ("GET", "/api/addons"): "Tool Store is a member-visible tab; Home only hides the card",
    ("GET", "/api/skills"): "Tool Store is a member-visible tab; Home only hides the card",
    ("GET", "/api/system/tabs"): "members need the installed tabs to render their own sidebar",
    ("GET", "/api/permissions"): "scoped to the member's own grants and audit entries (test below)",
    ("POST", "/api/skills"): "members may create skills (David's decision, 2026-10-27)",
    ("DELETE", "/api/permissions/{rule_id}"): "rules are kept per account (phase 4b): a member revokes only their own",
    ("GET", "/api/runs"): "runs live in the account's own chat database (phase 4b): a member sees only their own",
    ("GET", "/api/agents"): "per account since phase 4c: a member reaches only their own bots",
    ("POST", "/api/agents"): "per account since phase 4c: a member reaches only their own bots (held at Ask without machine access)",
    ("GET", "/api/agents/inbox"): "per account since phase 4c: a member reaches only their own bots' inbox",
    ("GET", "/api/agents/{agent_id}"): "per account since phase 4c: a member reaches only their own bots",
    ("PATCH", "/api/agents/{agent_id}"): "per account since phase 4c: a member reaches only their own bots",
    ("DELETE", "/api/agents/{agent_id}"): "per account since phase 4c: a member reaches only their own bots",
    ("POST", "/api/agents/{agent_id}/forget-logins"): "per account since phase 4c: a member reaches only their own bots' saved logins",
    ("GET", "/api/integrations"): "per account since phase 4c: a member reaches only their own integrations",
    ("GET", "/api/store/catalog"): "per account since phase 4c: a member reaches only their own store installs (tabs stay admin)",
    ("GET", "/api/settings"): "per account since phase 4c: a member reaches only their own account settings",
    ("POST", "/api/settings/computer-steps"): "per account since phase 4c: a member reaches only their own computer-step days (an account setting)",
    ("GET", "/api/file-checkpoints"): "per account since phase 4c: a member reaches only their own file checkpoints",
    ("GET", "/api/file-checkpoints/{event_id}"): "per account since phase 4c: a member reaches only their own file checkpoints",
    ("POST", "/api/file-checkpoints/{event_id}/restore"): "per account since phase 4c: a member reaches only their own file checkpoints (restoring needs machine access)",
}
# Answers the Electron window's cookie only, never a session (routes/cli_routes.py).
APP_WINDOW_ONLY = {"/api/auth/cli/terminals"}
CALL = re.compile(r"""api\(\s*[`"']([^`"']+)[`"']""")


def _function_body(src: str, name: str) -> str:
    match = re.search(r"(?:async\s+)?function\s+" + name + r"\s*\(", src)
    if not match:
        return ""
    start = src.index("{", match.end())
    depth = 0
    for i in range(start, len(src)):
        depth += src[i] == "{"
        depth -= src[i] == "}"
        if depth == 0:
            return src[start:i]
    return ""


def admin_surface_paths() -> dict[str, str]:
    """{api path: where the UI calls it} for every admin-only surface."""
    settings = (ROOT / "static/js/views/settings.js").read_text(encoding="utf-8")
    renders = set(re.findall(r'render: (\w+), admin: true', settings))
    group = settings[settings.index('id: "administration"'):]
    renders |= set(re.findall(r"render: (\w+)", group[:group.index("];")]))
    found = {}
    for name in sorted(renders):
        for path in CALL.findall(_function_body(settings, name)):
            found.setdefault(path, f"Settings {name}")
    home = (ROOT / "static/js/views/home.js").read_text(encoding="utf-8")
    admin_reads = home[home.index("const adminReads"):]
    admin_reads = admin_reads[admin_reads.index("Promise.allSettled"):admin_reads.index("].map")]
    for path in re.findall(r'"(/api/[^"]+)"\]', admin_reads):
        found.setdefault(path, "Home admin card")
    clean = {}
    for path, where in found.items():
        path = re.sub(r"\$\{[^}]*\}", "probe-id", path.split("?")[0])
        if path not in SHARED:
            clean[path] = where
    return clean


_ROUTES = None


def routes_for(path: str) -> list[tuple[str, str]]:
    # Included routers are lazy in this FastAPI, so read the app's own schema.
    global _ROUTES
    if _ROUTES is None:
        _ROUTES = [(compile_path(template)[0], template, method.upper())
                   for template, item in app.openapi()["paths"].items() for method in item]
    return [(method, template) for regex, template, method in _ROUTES if regex.match(path)]


class NavAuthorizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password", is_admin=True)
        auth_manager.create_user("member", "member-password")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))
        cls.paths = admin_surface_paths()

    def test_the_audit_found_the_admin_surfaces(self):
        wheres = set(self.paths.values())
        for expected in ("renderUsersPanel", "renderSystemPanel", "renderFileCheckpointsPanel", "Home admin card"):
            self.assertTrue(any(expected in w for w in wheres), f"{expected} was not parsed; the audit would be silently empty")
        self.assertGreater(len(self.paths), 20)
        unmatched = [p for p in self.paths if not routes_for(p)]
        self.assertEqual(unmatched, [], "every path the UI calls exists in the app")

    def test_members_and_anonymous_requests_are_refused(self):
        for path, where in sorted(self.paths.items()):
            for method, route in routes_for(path):
                if (method, route) in MEMBER_OK:
                    continue
                with self.subTest(where=where, method=method, route=route):
                    body = None if method == "GET" else {}
                    member = self.member.request(method, path, json=body)
                    self.assertIn(member.status_code, (401, 403), f"member {method} {path} -> {member.status_code}")
                    anon = self.anon.request(method, path, json=body)
                    self.assertIn(anon.status_code, (401, 403), f"anonymous {method} {path} -> {anon.status_code}")

    def test_members_see_only_their_own_permissions(self):
        # Every account has its own grants and audit trail (Multi-Account group 6, decision D2: the admin
        # cannot read another account's either).
        from core import accounts, permissions
        from core.auth import auth_manager
        for user, rule, audit in (("boss", {"id": "r-boss", "tool": "Bash", "content": "git status", "granted_by": "boss", "scope": "forever"},
                                   [{"at": 1, "decision": "allowed", "tool": "Bash", "content": "secret-command", "by": "boss"},
                                    {"at": 3, "decision": "revoked", "rule_id": "x"}]),
                                  ("member", {"id": "r-member", "tool": "read_file", "content": "notes", "granted_by": "member", "scope": "forever"},
                                   [{"at": 2, "decision": "allowed", "tool": "read_file", "content": "notes", "by": "member"}])):
            with accounts.as_account(auth_manager.account_id(user)):
                data = permissions._load()
                data["rules"] = [rule]
                data["audit"] = audit
                permissions._save(data)
        mine = self.member.get("/api/permissions").json()
        self.assertEqual([r["id"] for r in mine["rules"]], ["r-member"])
        self.assertEqual([e.get("by") for e in mine["audit"]], ["member"])
        self.assertNotIn("secret-command", str(mine))
        theirs = self.admin.get("/api/permissions").json()
        self.assertEqual([r["id"] for r in theirs["rules"]], ["r-boss"])
        self.assertEqual(len(theirs["audit"]), 2)
        self.assertNotIn("notes", str(theirs["rules"]))

    def test_admins_can_read_them(self):
        for path, where in sorted(self.paths.items()):
            if path in APP_WINDOW_ONLY or "GET" not in [m for m, _ in routes_for(path)]:
                continue
            with self.subTest(where=where, path=path):
                self.assertNotIn(self.admin.get(path).status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
