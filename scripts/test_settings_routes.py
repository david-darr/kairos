"""Settings routes that had no test: agent tools, extra allowed tools,
auto-compact, onboarding, the Vault folder and the Settings read.

Proves save -> persisted -> read back -> revert, that an open chat picks a
tool change up on its next turn, that members and anonymous callers are
refused on every route, and that a refused or failing change leaves the saved
setting alone. Temp folders only; nothing touches a real vault.

    .venv\\Scripts\\python.exe scripts\\test_settings_routes.py
"""
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="g7-settings-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app import app
from core import permissions, settings as settings_store
from core.auth import SESSION_COOKIE_NAME, auth_manager

logging.disable(logging.CRITICAL)


class SettingsRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}; auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        auth_manager.create_user("member", "member-password-1")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))
        cls.saved = dict(settings_store.load_settings())

    @classmethod
    def tearDownClass(cls):
        from core import session_manager_store
        session_manager_store.close()

    def tearDown(self):
        settings_store.update_settings(**{k: self.saved[k] for k in ("disabled_tools", "extra_allowed_tools", "auto_compact", "vault_dir", "onboarding_complete", "computer_use")})

    def test_every_route_is_admin_only(self):
        probes = (("get", "", None), ("post", "/computer-use", {"enabled": True}), ("post", "/computer-steps", {"days": 7}),
                  ("post", "/auto-compact", {"enabled": True}), ("post", "/helpers", {}), ("post", "/onboarding-complete", {}),
                  ("post", "/vault-dir", {"path": "x"}), ("post", "/vault-setup", {}), ("get", "/agent-tools", None),
                  ("post", "/agent-tools", {"disabled_tools": []}), ("post", "/extra-allowed-tools", {"extra_allowed_tools": ["x"]}))
        before = dict(settings_store.load_settings())
        for method, path, body in probes:
            for who, c in (("member", self.member), ("anonymous", self.anon)):
                got = getattr(c, method)("/api/settings" + path, **({} if body is None else {"json": body}))
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
        self.assertEqual(settings_store.load_settings(), before, "refused requests changed nothing")

    def test_agent_tools_save_revert_and_validate(self):
        listing = self.admin.get("/api/settings/agent-tools").json()
        self.assertTrue(listing["available"])
        tool = listing["available"][0]
        self.assertEqual(self.admin.post("/api/settings/agent-tools", json={"disabled_tools": [tool]}).json(), {"ok": True})
        self.assertEqual(self.admin.get("/api/settings/agent-tools").json()["disabled"], [tool])
        self.assertEqual(self.admin.get("/api/settings").json()["disabled_tools"], [tool], "the Settings read agrees")
        self.assertEqual(self.admin.post("/api/settings/agent-tools", json={"disabled_tools": ["NotATool"]}).status_code, 400)
        self.assertEqual(self.admin.get("/api/settings/agent-tools").json()["disabled"], [tool], "a refused change keeps the saved list")
        self.admin.post("/api/settings/agent-tools", json={"disabled_tools": []})
        self.assertEqual(self.admin.get("/api/settings/agent-tools").json()["disabled"], [], "revert")

    def test_an_open_chat_picks_up_a_tool_change_on_its_next_turn(self):
        from core.brain import Brain
        brain = Brain(model=None)
        brain._client = object()  # as if connected
        brain.tool_fingerprint = brain._fingerprint(*brain._tool_config())
        self.assertFalse(brain.tool_config_changed())
        tool = self.admin.get("/api/settings/agent-tools").json()["available"][0]
        self.admin.post("/api/settings/agent-tools", json={"disabled_tools": [tool]})
        self.assertTrue(brain.tool_config_changed(), "disabling a tool is noticed by the open chat")
        self.admin.post("/api/settings/agent-tools", json={"disabled_tools": []})
        self.assertFalse(brain.tool_config_changed(), "putting it back is noticed too")
        self.admin.post("/api/settings/computer-use", json={"enabled": True})
        self.assertTrue(brain.tool_config_changed(), "turning Computer use on is noticed")
        self.admin.post("/api/settings/computer-use", json={"enabled": False})
        self.assertFalse(brain.tool_config_changed())

    def test_computer_use_round_trips_every_switch(self):
        for value in ({"enabled": True, "allow_non_admins": True, "allow_reactions": True, "desktop": True},
                      {"enabled": False, "allow_non_admins": False, "allow_reactions": False, "desktop": False}):
            self.assertEqual(self.admin.post("/api/settings/computer-use", json=value).json()["computer_use"], value)
            self.assertEqual(self.admin.get("/api/settings").json()["computer_use"], value)
        self.assertEqual(self.admin.post("/api/settings/computer-use", json={"allow_non_admins": True}).status_code, 422, "enabled is required")
        self.assertEqual(self.admin.post("/api/settings/computer-steps", json={"days": 5}).status_code, 422)

    def test_extra_allowed_tools_grant_once_and_never_undo_a_revocation(self):
        self.admin.post("/api/settings/extra-allowed-tools", json={"extra_allowed_tools": ["  mcp__x__one  ", "", "mcp__x__two"]})
        self.assertEqual(self.admin.get("/api/settings/agent-tools").json()["extra_allowed"], ["mcp__x__one", "mcp__x__two"], "trimmed, blanks dropped")
        rule = next(r for r in permissions.list_rules() if r["tool"] == "mcp__x__one")
        self.assertEqual(rule["granted_by"], "boss", "the grant names who made it")
        self.assertEqual(self.admin.delete(f"/api/permissions/{rule['id']}").status_code, 200)
        self.admin.post("/api/settings/extra-allowed-tools", json={"extra_allowed_tools": ["mcp__x__one", "mcp__x__two"]})
        self.assertFalse([r for r in permissions.list_rules() if r["tool"] == "mcp__x__one"], "re-saving the same list does not undo a revocation")
        self.admin.post("/api/settings/extra-allowed-tools", json={"extra_allowed_tools": []})
        self.assertEqual(self.admin.get("/api/settings/agent-tools").json()["extra_allowed"], [])

    def test_auto_compact_and_onboarding_persist(self):
        self.assertEqual(self.admin.post("/api/settings/auto-compact", json={"enabled": False}).json()["auto_compact"], False)
        self.assertEqual(self.admin.get("/api/settings").json()["auto_compact"], False)
        self.admin.post("/api/settings/auto-compact", json={"enabled": True})
        self.assertEqual(self.admin.get("/api/settings").json()["auto_compact"], True)
        self.admin.post("/api/settings/onboarding-complete")
        self.assertTrue(self.admin.get("/api/settings").json()["onboarding_complete"])

    def test_the_vault_folder_is_seeded_only_when_empty_and_reads_back(self):
        empty = Path(tempfile.mkdtemp(dir=_DATA.name)) / "new vault"
        self.assertEqual(self.admin.post("/api/settings/vault-dir", json={"path": str(empty)}).status_code, 200)
        self.assertEqual(self.admin.get("/api/settings").json()["vault_dir"], str(empty))
        self.assertTrue((empty / "Vault Index.md").exists(), "an empty folder gets the starter notes")
        real = Path(tempfile.mkdtemp(dir=_DATA.name))
        (real / "my note.md").write_text("mine", encoding="utf-8")
        self.admin.post("/api/settings/vault-dir", json={"path": str(real)})
        self.assertEqual(sorted(p.name for p in real.iterdir()), ["my note.md"], "an existing vault is never written into")

    def test_a_vault_folder_that_cannot_be_used_is_refused_and_the_saved_one_stays(self):
        good = Path(tempfile.mkdtemp(dir=_DATA.name))
        self.admin.post("/api/settings/vault-dir", json={"path": str(good)})
        # Relative paths resolve against the process folder: run from a scratch folder so nothing lands in the repo.
        scratch = tempfile.mkdtemp(dir=_DATA.name)
        previous = os.getcwd()
        os.chdir(scratch)
        self.addCleanup(os.chdir, previous)
        occupied = Path(tempfile.mkdtemp(dir=_DATA.name)) / "a-file"
        occupied.write_text("not a folder", encoding="utf-8")
        for bad in (str(occupied), "relative/folder", "", "bad\x00name"):
            try:
                response = self.admin.post("/api/settings/vault-dir", json={"path": bad})
                status = response.status_code
            except Exception as error:  # an unhandled server error surfaces as an exception in the test client
                status = f"500 ({type(error).__name__})"
            with self.subTest(path=repr(bad)):
                self.assertIn(status, (400, 422), f"{bad!r} was not refused cleanly: {status}")
                self.assertEqual(self.admin.get("/api/settings").json()["vault_dir"], str(good), "a refused folder must not replace the saved one")


if __name__ == "__main__":
    unittest.main()
