"""Account folders: ids, the resolver, the per-request account, the layout migration (Multi-Account
(Build Spec), phase 1, 2026-11-05) and the per-account stores (phase 2 group 1: notes, calendar,
documents, projects, contacts).

Runs on a throwaway data folder. The leak test (scripts/test_account_isolation.py) covers what each
account can read through the real routes; this covers the machinery underneath it.
"""
import asyncio
import json
import os
import sys
import tempfile
import shutil
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-accounts-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import httpx  # noqa: E402
from fastapi import FastAPI, WebSocket  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import account_migration, accounts, auth, backup, contacts_store, projects, tool_access  # noqa: E402
from core import middleware  # noqa: E402
from core import settings as settings_store, vault as vault_module, vault_sync  # noqa: E402
from core.memory import vault as memory_vault  # noqa: E402
from services import calendar_service as calendar_module, documents_service  # noqa: E402
from services import notes_service as notes_module  # noqa: E402
from core.auth import SESSION_COOKIE_NAME, SINGLE_USER, auth_manager  # noqa: E402


def fresh_users():
    auth_manager._users = {"users": {}}
    auth_manager._sessions = {}


def mini_app():
    """The real middleware and sign-in check around routes that report the account they see."""
    app = FastAPI()

    @app.get("/sync")
    def sync_route():
        return {"account": accounts.current_account()}

    @app.get("/slow")
    async def slow_route():
        before = accounts.current_account()
        await asyncio.sleep(0.05)  # the other request runs meanwhile
        return {"before": before, "after": accounts.current_account()}

    @app.get("/spawn")
    async def spawn_route():
        async def later():
            await asyncio.sleep(0.01)
            return accounts.current_account()
        return {"task": await asyncio.create_task(later())}

    @app.get("/notes")
    def notes_route():
        return notes_module.notes_service.list_notes()

    @app.post("/tool")
    def tool_route():
        return {"account": accounts.current_account()}

    @app.websocket("/ws")
    async def ws_route(socket: WebSocket):
        await socket.accept()
        await socket.send_json({"account": accounts.current_account()})
        await socket.close()

    app.add_middleware(middleware.AccountContextMiddleware)

    @app.exception_handler(accounts.NoAccount)
    async def no_account(request, exc):  # the same handler app.py installs
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    return app


class AccountIds(unittest.TestCase):
    def setUp(self):
        fresh_users()

    def test_each_account_gets_its_own_safe_id(self):
        auth_manager.create_user("David", "password-one-1", is_admin=True)
        auth_manager.create_user("david", "password-two-2")
        first, second = auth_manager.account_id("David"), auth_manager.account_id("david")
        self.assertNotEqual(first.lower(), second.lower(), "names that differ by case never share a folder")
        for account_id in (first, second):
            self.assertRegex(account_id, r"^[0-9a-f]{12}$")
            self.assertTrue(accounts.account_dir(account_id).endswith(os.path.join("accounts", account_id)))

    def test_an_older_record_gets_an_id_once_and_keeps_it(self):
        auth_manager._users = {"users": {"bea": {"is_admin": False, "created_at": 1}}}
        first = auth_manager.account_id("bea")
        self.assertEqual(auth_manager.account_id("bea"), first)
        saved = json.loads(Path(auth.AUTH_FILE).read_text(encoding="utf-8"))
        self.assertEqual(saved["users"]["bea"]["account_id"], first, "the id is written to auth.json")
        self.assertIsNone(auth_manager.account_id("nobody"))

    def test_the_first_account_takes_over_the_local_folder(self):
        local = os.path.join(accounts.ACCOUNTS_DIR, accounts.LOCAL_ID)
        os.makedirs(local, exist_ok=True)
        try:
            auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
            auth_manager.create_user("bea", "password-two-2")
            self.assertEqual(auth_manager.account_id("david-darr"), accounts.LOCAL_ID)
            self.assertNotEqual(auth_manager.account_id("bea"), accounts.LOCAL_ID, "only the first one")
        finally:
            os.rmdir(local)

    def test_without_a_local_folder_the_first_account_is_random_too(self):
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        self.assertNotEqual(auth_manager.account_id("david-darr"), accounts.LOCAL_ID)


class Resolver(unittest.TestCase):
    def setUp(self):
        fresh_users()

    def test_a_request_with_nobody_signed_in_gets_no_folder(self):
        token = accounts.set_current(None)
        try:
            self.assertIsNone(accounts.current_account())
            with self.assertRaises(accounts.NoAccount):
                accounts.account_dir()
            with patch.object(account_migration, "moved_names", return_value=frozenset({"notes.json"})):
                with self.assertRaises(accounts.NoAccount):
                    notes_module.notes_service.list_notes()
        finally:
            accounts.reset_current(token)

    def test_background_work_not_yet_per_account_uses_the_first_admins(self):
        self.assertIsNone(accounts.current_account(), "nothing set: start-up or a background loop")
        self.assertTrue(accounts.account_dir().endswith(accounts.LOCAL_ID), "no accounts yet: local")
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        self.assertTrue(accounts.account_dir().endswith(auth_manager.account_id("david-darr")))

    def test_ids_cannot_leave_the_accounts_folder(self):
        for bad in ("../auth", "a/b", "A1", "", ".", "x" * 33, "a b"):
            with self.assertRaises((ValueError, accounts.NoAccount)):
                accounts.account_dir(bad)

    def test_background_work_runs_as_one_account_and_then_none(self):
        with accounts.as_account("abc123"):
            self.assertEqual(accounts.current_account(), "abc123")
            with accounts.as_account("def456"):
                self.assertEqual(accounts.current_account(), "def456")
            self.assertEqual(accounts.current_account(), "abc123")
            self.assertTrue(accounts.account_dir().endswith("abc123"))
        self.assertIsNone(accounts.current_account())

    def test_parallel_jobs_each_keep_their_own_account(self):
        async def job(account_id):
            with accounts.as_account(account_id):
                await asyncio.sleep(0.02)
                return accounts.current_account()
        async def both():
            return await asyncio.gather(job("aaa111"), job("bbb222"))
        self.assertEqual(asyncio.run(both()), ["aaa111", "bbb222"])

    def test_accounts_off_is_the_first_admin_or_local(self):
        self.assertEqual(accounts.local_account(), accounts.LOCAL_ID, "no accounts yet")
        self.assertEqual(accounts.all_accounts(), [accounts.LOCAL_ID])
        auth_manager.create_user("bea", "password-two-2")
        self.assertEqual(accounts.local_account(), accounts.LOCAL_ID, "a non-admin is never the local user")
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("cal", "password-three-3", is_admin=True)
        self.assertEqual(accounts.local_account(), auth_manager.account_id("david-darr"), "the earliest admin")
        self.assertEqual(accounts.account_for_user(SINGLE_USER), auth_manager.account_id("david-darr"))
        self.assertEqual(sorted(accounts.all_accounts()),
                         sorted(auth_manager.account_id(n) for n in ("bea", "david-darr", "cal")))
        self.assertIsNone(accounts.account_for_user(None))
        self.assertIsNone(accounts.account_for_user("deleted-user"))


class PerRequest(unittest.TestCase):
    def setUp(self):
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.ids = {n: auth_manager.account_id(n) for n in ("david-darr", "bea")}
        self.tokens = {n: auth_manager.create_session(n) for n in self.ids}
        self.app = mini_app()

    def client(self, name=None):
        client = TestClient(self.app)
        if name:
            client.cookies.set(SESSION_COOKIE_NAME, self.tokens[name])
        return client

    def test_each_signed_in_request_sees_its_own_account(self):
        with patch.object(middleware, "auth_enabled", return_value=True):
            for name, account_id in self.ids.items():
                self.assertEqual(self.client(name).get("/sync").json(), {"account": account_id})
            self.assertEqual(self.client().get("/sync").json(), {"account": None}, "no sign-in, no account")
            bad = self.client(); bad.cookies.set(SESSION_COOKIE_NAME, "not-a-session")
            self.assertEqual(bad.get("/sync").json(), {"account": None})

    def test_two_requests_at_once_never_see_each_other(self):
        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async def one(name):
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1",
                                             cookies={SESSION_COOKIE_NAME: self.tokens[name]}) as client:
                    return (await client.get("/slow")).json()
            return await asyncio.gather(*(one(n) for n in ("david-darr", "bea", "david-darr", "bea")))
        with patch.object(middleware, "auth_enabled", return_value=True):
            results = asyncio.run(run())
        for result, name in zip(results, ("david-darr", "bea", "david-darr", "bea")):
            self.assertEqual(result, {"before": self.ids[name], "after": self.ids[name]})

    def test_work_a_request_starts_keeps_its_account(self):
        with patch.object(middleware, "auth_enabled", return_value=True):
            self.assertEqual(self.client("bea").get("/spawn").json(), {"task": self.ids["bea"]})

    def test_a_websocket_knows_its_account(self):
        with patch.object(middleware, "auth_enabled", return_value=True):
            with self.client("bea").websocket_connect("/ws") as socket:
                self.assertEqual(socket.receive_json(), {"account": self.ids["bea"]})
            with self.client().websocket_connect("/ws") as socket:
                self.assertEqual(socket.receive_json(), {"account": None})

    def test_accounts_off_the_app_window_works_in_the_first_admins_account(self):
        with patch.object(middleware, "auth_enabled", return_value=False), patch.object(auth, "UI_SECRET", None):
            self.assertEqual(self.client().get("/sync").json(), {"account": self.ids["david-darr"]})
        with patch.object(middleware, "auth_enabled", return_value=False), patch.object(auth, "UI_SECRET", "s3cret"):
            self.assertEqual(self.client().get("/sync").json(), {"account": None},
                             "without the window's cookie a local request is nobody, as before")

    def test_the_app_sets_the_account_before_anything_else(self):
        source = (ROOT / "app.py").read_text(encoding="utf-8")
        security = source.index("app.add_middleware(SecurityHeadersMiddleware)")
        account = source.index("app.add_middleware(AccountContextMiddleware)")
        self.assertGreater(account, security, "added last, so it runs first")
        self.assertEqual(source.count("app.add_middleware("), 2, "no other layer runs before it")


class Migration(unittest.TestCase):
    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout-", dir=tempfile.gettempdir())
        self.data = Path(self.root.name)
        (self.data / "chats").mkdir()
        (self.data / "chats" / "one.json").write_text("{}", encoding="utf-8")
        (self.data / "notes.json").write_text("[]", encoding="utf-8")
        (self.data / "settings.json").write_text("{}", encoding="utf-8")
        self.steps = [account_migration.Step(1, "chats", ("chats",)),
                      account_migration.Step(2, "notes", ("notes.json", "missing.json"))]
        self.backups = []

    def tearDown(self):
        self.root.cleanup()

    def backup(self, path):
        self.backups.append(path)
        Path(path).write_text("backup", encoding="utf-8")

    def run_steps(self, steps=None, **kwargs):
        return account_migration.run(str(self.data), self.steps if steps is None else steps, account="abc123",
                                     backup=kwargs.pop("backup", self.backup), **kwargs)

    def test_group_one_moves_its_five_stores(self):
        self.assertEqual([s.version for s in account_migration.STEPS], [1, 2, 3, 4, 5, 6, 7], "group 7 added the creative step")
        self.assertEqual(set(account_migration.STEPS[0].entries), {
            "notes.json", "calendar_events.json", "documents", "documents_index.json", "projects.json", "contacts.json"})
        (self.data / "documents").mkdir()
        (self.data / "documents" / "a.md").write_text("doc", encoding="utf-8")
        result = account_migration.run(str(self.data), account="abc123", backup=self.backup)
        self.assertTrue(result["ok"], result)
        account = self.data / "accounts" / "abc123"
        self.assertTrue((account / "notes.json").exists() and (account / "documents" / "a.md").exists())
        self.assertTrue((self.data / "chats" / "one.json").exists(), "chats wait for their own group")

    def test_a_new_install_records_the_layout_without_a_backup(self):
        empty = TemporaryDirectory(prefix="kairos-layout-new-", dir=tempfile.gettempdir())
        self.addCleanup(empty.cleanup)
        result = account_migration.run(empty.name, account="abc123", backup=self.backup)
        self.assertTrue(result["ok"])
        self.assertEqual(self.backups, [], "nothing to back up")
        self.assertEqual(account_migration.layout_version(empty.name), account_migration.STEPS[-1].version)
        self.assertIsNone(account_migration.run(empty.name, account="abc123", backup=self.backup))

    def test_pending_steps_move_into_the_account_after_a_backup(self):
        result = self.run_steps()
        self.assertTrue(result["ok"], result)
        account = self.data / "accounts" / "abc123"
        self.assertTrue((account / "chats" / "one.json").exists())
        self.assertTrue((account / "notes.json").exists())
        self.assertFalse((self.data / "chats").exists())
        self.assertTrue((self.data / "settings.json").exists(), "install-level files stay")
        self.assertEqual(account_migration.layout_version(str(self.data)), 2)
        self.assertIn("notes.json", account_migration.moved_names(str(self.data)), "group 1's names now read the account")
        self.assertEqual(len(self.backups), 1)
        self.assertIn(os.sep + ".layout" + os.sep, self.backups[0])
        self.assertIsNone(self.run_steps(), "a second start has nothing to do")

    def test_only_newer_steps_run(self):
        self.run_steps(self.steps[:1])
        self.assertEqual(account_migration.layout_version(str(self.data)), 1)
        result = self.run_steps()
        self.assertEqual(result["steps"], ["notes"])
        self.assertEqual(result["moved"], [os.path.join("accounts", "abc123", "notes.json")])

    def test_a_failed_move_puts_everything_back(self):
        account = self.data / "accounts" / "abc123"
        account.mkdir(parents=True)
        (account / "notes.json").write_text("someone else's", encoding="utf-8")
        result = self.run_steps()
        self.assertFalse(result["ok"])
        self.assertIn("already in the account folder", result["error"])
        self.assertTrue((self.data / "chats" / "one.json").exists(), "chats moved back")
        self.assertFalse((account / "chats").exists())
        self.assertEqual((account / "notes.json").read_text(encoding="utf-8"), "someone else's", "never merged")
        self.assertEqual(account_migration.layout_version(str(self.data)), 0, "still on the old layout")
        self.assertEqual(account_migration.moved_names(str(self.data)), frozenset(),
                         "so the stores keep reading the old place")
        record = json.loads((self.data / ".layout" / "last-run.json").read_text(encoding="utf-8"))
        self.assertFalse(record["ok"])
        self.assertIn("already in the account folder", record["error"], "the failure is kept where it can be read")

    def test_no_backup_no_move(self):
        def broken(path):
            raise OSError("disk full")
        result = self.run_steps(backup=broken)
        self.assertFalse(result["ok"])
        self.assertIn("backup failed", result["error"])
        self.assertTrue((self.data / "chats").exists())
        self.assertEqual(account_migration.layout_version(str(self.data)), 0)

    def test_backups_and_restores_leave_the_safety_copies_alone(self):
        self.run_steps()
        listed = [rel for _, rel in backup._files(str(self.data))]
        self.assertFalse([rel for rel in listed if rel.startswith(".layout/")], "not inside later backups")
        self.assertIn("accounts/abc123/notes.json", listed, "account folders are backed up")
        self.assertNotIn(".layout", backup._entries(str(self.data)), "a restore does not delete them")



class Stores(unittest.TestCase):
    """Group 1: each account has its own notes, calendar, documents, projects and contacts."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)  # what app.py does at start
        assert "notes.json" in account_migration.moved_names()

    def test_until_the_move_the_stores_stay_where_they_were(self):
        with patch.object(account_migration, "moved_names", return_value=frozenset()):
            self.assertEqual(accounts.path("notes.json"), os.path.join(_DATA.name, "notes.json"))
            with accounts.as_account(self.ids["bea"]):
                self.assertEqual(accounts.path("documents", "a.md"), os.path.join(_DATA.name, "documents", "a.md"))
        with accounts.as_account(self.ids["bea"]):
            self.assertEqual(accounts.path("documents", "a.md"),
                             os.path.join(accounts.ACCOUNTS_DIR, self.ids["bea"], "documents", "a.md"))
            self.assertEqual(accounts.path("tab-data"), os.path.join(_DATA.name, "tab-data"),
                             "tab data has not moved")

    def setUp(self):
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.ids = {n: auth_manager.account_id(n) for n in ("david-darr", "bea")}

    def test_each_account_has_its_own_of_every_store(self):
        made = {}
        for name, account_id in self.ids.items():
            with accounts.as_account(account_id):
                made[name] = {
                    "note": notes_module.notes_service.create_note(f"{name} note")["id"],
                    "event": calendar_module.calendar_service.create_event(
                        f"{name} event", "2026-11-10T10:00:00Z", "2026-11-10T11:00:00Z")["id"],
                    "document": documents_service.create_document(f"{name} document", "body")["id"],
                    "project": projects.create_project(f"{name} project")["id"],
                }
                contacts_store.replace_synced_contacts("sync", [{"uid": "1", "name": f"{name} contact"}])
        for name, account_id in self.ids.items():
            other = "bea" if name == "david-darr" else "david-darr"
            with accounts.as_account(account_id):
                self.assertEqual([n["text"] for n in notes_module.notes_service.list_notes()], [f"{name} note"])
                self.assertIsNone(notes_module.notes_service.get_note(made[other]["note"]))
                with self.assertRaises(KeyError):
                    calendar_module.calendar_service.get_event(made[other]["event"])
                self.assertIsNone(documents_service.get_document(made[other]["document"]))
                self.assertEqual([d["title"] for d in documents_service.list_documents()], [f"{name} document"])
                self.assertIsNone(projects.get_project(made[other]["project"]))
                self.assertEqual([c["name"] for c in contacts_store.list_contacts()], [f"{name} contact"])
                folder = Path(accounts.account_dir())
                for entry in ("notes.json", "calendar_events.json", "documents", "documents_index.json",
                              "projects.json", "contacts.json"):
                    self.assertTrue((folder / entry).exists(), f"{entry} lives in {name}'s folder")
        self.assertFalse((Path(_DATA.name) / "notes.json").exists(), "nothing at the old shared place")

    def test_a_test_can_still_point_a_store_at_its_own_file(self):
        own = TemporaryDirectory(prefix="kairos-own-", dir=tempfile.gettempdir())
        self.addCleanup(own.cleanup)
        with patch.object(notes_module, "NOTES_FILE", str(Path(own.name) / "notes.json")):
            notes_module.notes_service.create_note("pinned")
            self.assertTrue((Path(own.name) / "notes.json").exists())

    def test_a_signed_out_request_for_notes_is_refused(self):
        app = mini_app()
        with patch.object(middleware, "auth_enabled", return_value=True):
            self.assertEqual(TestClient(app).get("/notes").status_code, 401)
            client = TestClient(app)
            client.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("bea"))
            self.assertEqual(client.get("/notes").status_code, 200)

    def test_a_model_tool_call_works_in_its_turns_account(self):
        with accounts.as_account(self.ids["bea"]):
            token = tool_access.issue(None, False)
        self.addCleanup(tool_access.revoke, token)
        self.assertEqual(tool_access.resolve(token).account, self.ids["bea"])
        with patch.object(middleware, "auth_enabled", return_value=True):
            answer = TestClient(mini_app()).post("/tool", headers={"X-JARVIS-Tool-Token": token}).json()
            self.assertEqual(answer, {"account": self.ids["bea"]})
            wrong = TestClient(mini_app()).post("/tool", headers={"X-JARVIS-Tool-Token": "made-up"}).json()
            self.assertEqual(wrong, {"account": None})


def _restore_vault_state():
    """Remember JARVIS_VAULT_DIR and the install's vault_dir setting; returns a function that puts them back."""
    saved_env = os.environ.pop("JARVIS_VAULT_DIR", None)
    saved_setting = settings_store.load_settings().get("vault_dir")

    def restore():
        os.environ.pop("JARVIS_VAULT_DIR", None)
        if saved_env is not None:
            os.environ["JARVIS_VAULT_DIR"] = saved_env
        settings_store.update_settings(vault_dir=saved_setting)
    settings_store.update_settings(vault_dir=None)
    return restore


class VaultPerAccount(unittest.TestCase):
    """Group 2: each account has its own vault and its own search index."""

    def setUp(self):
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))
        bea_file = Path(accounts.account_dir(self.second)) / "settings.json"
        saved_bea = bea_file.read_bytes() if bea_file.exists() else None

        def restore_bea():
            if saved_bea is None:
                bea_file.unlink(missing_ok=True)
            else:
                bea_file.write_bytes(saved_bea)
        self.addCleanup(restore_bea)
        self.addCleanup(_restore_vault_state())
        bea_file.unlink(missing_ok=True)

    def chosen(self, account_id):
        with accounts.as_account(account_id):
            return vault_module.chosen_vault_dir()

    def test_the_first_admin_keeps_settings_then_env_then_the_default(self):
        with patch.object(account_migration, "moved_names", return_value=frozenset({"vault"})):
            self.assertEqual(self.chosen(self.first), os.path.join(accounts.ACCOUNTS_DIR, self.first, "vault"))
        with patch.object(account_migration, "moved_names", return_value=frozenset()):
            self.assertEqual(self.chosen(self.first), os.path.join(_DATA.name, "vault"), "before the move")
        os.environ["JARVIS_VAULT_DIR"] = os.path.join(_DATA.name, "from-env")
        self.assertEqual(self.chosen(self.first), os.path.join(_DATA.name, "from-env"))
        settings_store.update_settings(vault_dir=os.path.join(_DATA.name, "from-settings"))
        self.assertEqual(self.chosen(self.first), os.path.join(_DATA.name, "from-settings"), "settings beat the env")

    def test_another_account_never_gets_the_first_admins_choice(self):
        own = os.path.join(accounts.ACCOUNTS_DIR, self.second, "vault")
        os.environ["JARVIS_VAULT_DIR"] = os.path.join(_DATA.name, "from-env")
        settings_store.update_settings(vault_dir=os.path.join(_DATA.name, "from-settings"))
        self.assertEqual(self.chosen(self.second), own)
        self.assertNotEqual(self.chosen(self.first), own)
        with patch.object(account_migration, "moved_names", return_value=frozenset()):
            self.assertEqual(self.chosen(self.second), own, "with or without the move: its own folder")

    def test_an_accounts_own_setting_wins_for_it_only(self):
        chosen = os.path.join(_DATA.name, "beas-obsidian")
        with accounts.as_account(self.second):
            vault_module.set_vault_dir(chosen)
        self.assertEqual(self.chosen(self.second), chosen)
        self.assertNotEqual(self.chosen(self.first), chosen)
        self.assertIsNone(settings_store.get_setting("vault_dir"), "the install's settings are untouched")
        saved = json.loads((Path(accounts.account_dir(self.second)) / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["vault_dir"], chosen)

    def test_the_first_admin_sets_the_install_wide_setting(self):
        chosen = os.path.join(_DATA.name, "davids-obsidian")
        with accounts.as_account(self.first):
            vault_module.set_vault_dir(chosen)
        self.assertEqual(settings_store.get_setting("vault_dir"), chosen)
        self.assertIsNone(settings_store.get_account_setting("vault_dir", self.first), "not in their account file")
        self.assertEqual(self.chosen(self.first), chosen)
        self.assertNotEqual(self.chosen(self.second), chosen)

    def test_two_accounts_on_one_vault_folder_get_separate_indexes(self):
        shared = TemporaryDirectory(prefix="kairos-shared-vault-", dir=tempfile.gettempdir())
        self.addCleanup(shared.cleanup)
        memories = {}
        with patch.object(memory_vault, "INDEX_DIR", None), \
                patch.object(account_migration, "moved_names", return_value=frozenset({"memory", "vault"})):
            for name, account_id in (("first", self.first), ("second", self.second)):
                with accounts.as_account(account_id):
                    memories[name] = memory_vault.VaultMemory.for_dir(shared.name)
                    self.assertIs(memory_vault.VaultMemory.for_dir(shared.name), memories[name], "cached per account")
                    folder = os.path.join(accounts.ACCOUNTS_DIR, account_id, "memory")
                    self.assertEqual(memory_vault.index_dir(), folder)
                    self.assertEqual(os.path.dirname(memories[name].db_path), folder)
        self.assertIsNot(memories["first"], memories["second"])
        self.assertNotEqual(memories["first"].db_path, memories["second"].db_path)
        self.assertEqual(memories["first"].vault_dir, memories["second"].vault_dir, "same folder, two indexes")

    def test_for_dir_keys_by_vault_and_index_folder(self):
        one, two, vault = (TemporaryDirectory(prefix="kairos-idx-", dir=tempfile.gettempdir()) for _ in range(3))
        for folder in (one, two, vault):
            self.addCleanup(folder.cleanup)
        with patch.object(memory_vault, "INDEX_DIR", one.name):
            first = memory_vault.VaultMemory.for_dir(vault.name)
            self.assertIs(memory_vault.VaultMemory.for_dir(vault.name), first)
            self.assertEqual(os.path.dirname(first.db_path), one.name)
        with patch.object(memory_vault, "INDEX_DIR", two.name):
            second = memory_vault.VaultMemory.for_dir(vault.name)
        self.assertIsNot(first, second, "another index folder, another index")
        self.assertEqual(os.path.dirname(second.db_path), two.name)
        self.assertEqual(os.path.basename(first.db_path), os.path.basename(second.db_path), "same vault, same file name")


class VaultMigration(unittest.TestCase):
    """Migration step 2: the search index and the default vault move into the account folder."""

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout2-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name)
        (self.data / "memory").mkdir()
        (self.data / "memory" / "vault-abc.db").write_text("index", encoding="utf-8")
        (self.data / "vault" / "01 - Daily Notes").mkdir(parents=True)
        (self.data / "vault" / "Active Priorities.md").write_text("# Priorities", encoding="utf-8")
        (self.data / "vault" / "01 - Daily Notes" / "today.md").write_text("today", encoding="utf-8")
        self.layout = self.data / ".layout"
        self.account = self.data / "accounts" / "abc123"
        self.addCleanup(_restore_vault_state())
        self.step = account_migration.STEPS[1]
        self.assertEqual((self.step.version, self.step.entries, self.step.copy_first), (2, ("memory", "vault"), ("vault",)))

    def backup(self, path):
        Path(path).write_text("backup", encoding="utf-8")

    def run_step(self, step=None):
        return account_migration.run(str(self.data), [step or self.step], account="abc123", backup=self.backup)

    def vault_files(self, folder):
        return sorted(os.path.relpath(os.path.join(root, name), folder).replace(os.sep, "/")
                      for root, _, names in os.walk(folder) for name in names)

    def test_memory_and_vault_move_with_a_copy_of_the_vault(self):
        before = self.vault_files(self.data / "vault")
        result = self.run_step()
        self.assertTrue(result["ok"], result)
        self.assertEqual(sorted(result["moved"]), sorted(os.path.join("accounts", "abc123", n) for n in ("memory", "vault")))
        self.assertEqual(result["kept"], [])
        self.assertFalse((self.data / "memory").exists() or (self.data / "vault").exists())
        self.assertEqual(self.vault_files(self.account / "vault"), before)
        self.assertTrue((self.account / "memory" / "vault-abc.db").exists())
        (copy,) = result["copies"]
        self.assertRegex(os.path.basename(copy), r"^before-layout-2-\d{8}-\d{6}-vault$")
        self.assertEqual(os.path.dirname(copy), str(self.layout))
        self.assertEqual(self.vault_files(copy), before, "the copy holds the same files")
        self.assertTrue(result["backup"].endswith(".zip") and os.path.exists(result["backup"]))
        self.assertEqual(account_migration.layout_version(str(self.data)), 2)
        self.assertIn("vault", account_migration.moved_names(str(self.data)))

    def test_a_vault_that_is_kept_stays_while_memory_moves(self):
        kept = account_migration.Step(2, "memory and the vault", ("memory", "vault"), copy_first=("vault",),
                                      keep=lambda data_dir: {"vault"})
        result = self.run_step(kept)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["kept"], ["vault"])
        self.assertEqual(result["moved"], [os.path.join("accounts", "abc123", "memory")])
        self.assertTrue((self.data / "vault" / "Active Priorities.md").exists())
        self.assertFalse((self.account / "vault").exists())
        self.assertTrue((self.account / "memory" / "vault-abc.db").exists())
        self.assertNotIn("copies", result, "nothing moved, so no copy")

    def test_a_vault_named_in_settings_or_the_env_is_kept(self):
        self.assertEqual(account_migration._vault_in_use(str(self.data)), set())
        os.environ["JARVIS_VAULT_DIR"] = str(self.data / "vault")
        self.assertEqual(account_migration._vault_in_use(str(self.data)), {"vault"})
        os.environ.pop("JARVIS_VAULT_DIR")
        settings_store.update_settings(vault_dir=str(self.data / "vault"))
        self.assertEqual(account_migration._vault_in_use(str(self.data)), {"vault"})
        settings_store.update_settings(vault_dir=str(self.data / "elsewhere"))
        self.assertEqual(account_migration._vault_in_use(str(self.data)), set(), "a different folder: it moves")
        settings_store.update_settings(vault_dir=str(self.data / "vault"))
        result = self.run_step()
        self.assertEqual(result["kept"], ["vault"])
        self.assertTrue((self.data / "vault").exists())

    def plant_old(self):
        self.layout.mkdir(exist_ok=True)
        old_zip = self.layout / "before-layout-1-20200101-000000.zip"
        old_copy = self.layout / "before-layout-1-20200101-000000-vault"
        old_zip.write_text("old", encoding="utf-8")
        old_copy.mkdir()
        (old_copy / "n.md").write_text("old", encoding="utf-8")
        return old_zip, old_copy

    def test_a_good_run_removes_older_safety_copies_and_keeps_its_own(self):
        old_zip, old_copy = self.plant_old()
        result = self.run_step()
        self.assertTrue(result["ok"], result)
        self.assertEqual(sorted(result["pruned"]), sorted([old_zip.name, old_copy.name]))
        self.assertFalse(old_zip.exists() or old_copy.exists())
        self.assertTrue(os.path.exists(result["backup"]))
        self.assertTrue(os.path.isdir(result["copies"][0]), "this run's own copy stays")

    def test_a_failed_run_keeps_older_backups_drops_its_own_and_moves_everything_back(self):
        old_zip, old_copy = self.plant_old()
        (self.account / "vault").mkdir(parents=True)
        (self.account / "vault" / "theirs.md").write_text("theirs", encoding="utf-8")
        result = self.run_step()
        self.assertFalse(result["ok"])
        self.assertIn("already in the account folder", result["error"])
        self.assertTrue(old_zip.exists() and old_copy.exists() and (old_copy / "n.md").exists())
        # Everything went back, so nothing changed: this run's own backup and vault copy are not kept,
        # or a start that fails every time would add one each time.
        self.assertEqual(sorted(result["pruned"]), sorted(os.path.basename(p) for p in [result["backup"], *result["copies"]]))
        self.assertFalse(os.path.exists(result["backup"]))
        self.assertFalse(os.path.exists(result["copies"][0]))
        self.assertTrue((self.data / "memory" / "vault-abc.db").exists(), "memory moved back")
        self.assertFalse((self.account / "memory").exists())
        self.assertTrue((self.data / "vault" / "01 - Daily Notes" / "today.md").exists(), "the vault never left")
        self.assertEqual((self.account / "vault" / "theirs.md").read_text(encoding="utf-8"), "theirs", "never merged")
        self.assertEqual(account_migration.layout_version(str(self.data)), 0)


class VaultSync(unittest.TestCase):
    """A vault task note is only removed when its file is there and the line is not."""

    def setUp(self):
        self.own = TemporaryDirectory(prefix="kairos-vsync-", dir=tempfile.gettempdir())
        self.addCleanup(self.own.cleanup)
        self.vault = Path(self.own.name) / "vault"
        self.vault.mkdir()
        self.file = self.vault / "Active Priorities.md"
        self.file.write_text("# Active Priorities\n\n## Work\n- [ ] ship the thing\n- [ ] write the docs\n",
                             encoding="utf-8")
        for patcher in (patch.object(notes_module, "NOTES_FILE", str(Path(self.own.name) / "notes.json")),
                        patch.object(vault_sync, "resolve_vault_dir", return_value=str(self.vault))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def texts(self):
        return sorted(n["text"] for n in notes_module.notes_service.list_notes(include_dismissed=True))

    def test_a_missing_file_removes_nothing_but_a_removed_line_does(self):
        native = notes_module.notes_service.create_note("app-native note")
        self.assertEqual(vault_sync.sync_from_vault()["imported"], 2)
        self.assertEqual(self.texts(), ["app-native note", "ship the thing", "write the docs"])
        self.file.unlink()
        summary = vault_sync.sync_from_vault()
        self.assertEqual((summary["removed"], summary["files"]), (0, 0))
        self.assertEqual(self.texts(), ["app-native note", "ship the thing", "write the docs"],
                         "a vault that moved wipes nothing")
        self.file.write_text("# Active Priorities\n\n## Work\n- [ ] ship the thing\n", encoding="utf-8")
        self.assertEqual(vault_sync.sync_from_vault()["removed"], 1)
        self.assertEqual(self.texts(), ["app-native note", "ship the thing"])
        self.assertIsNotNone(notes_module.notes_service.get_note(native["id"]))

    def test_an_empty_folder_removes_nothing_either(self):
        vault_sync.sync_from_vault()
        self.file.unlink()
        self.assertEqual(os.listdir(self.vault), [])
        self.assertEqual(vault_sync.sync_from_vault()["removed"], 0)
        self.assertEqual(len(notes_module.notes_service.list_notes(include_dismissed=True)), 2)


class VaultBackup(unittest.TestCase):
    """A backup leaves every account's default vault out, and a restore leaves it where it is."""

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-vbackup-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.base = Path(self.root.name)
        self.addCleanup(_restore_vault_state())

    def folder(self, name, notes):
        data = self.base / name
        for account in ("abc123", "def456"):
            (data / "accounts" / account / "vault").mkdir(parents=True)
            (data / "accounts" / account / "vault" / "Note.md").write_text(f"{account} vault", encoding="utf-8")
            (data / "accounts" / account / "notes.json").write_text(notes, encoding="utf-8")
        (data / "settings.json").write_text("{}", encoding="utf-8")
        return data

    def test_files_and_entries_leave_the_account_vaults_out(self):
        data = self.folder("live", "[]")
        self.assertEqual(backup._account_vaults(str(data)),
                         [os.path.join("accounts", "abc123", "vault"), os.path.join("accounts", "def456", "vault")])
        self.assertEqual(backup._vaults_inside(str(data)),
                         {os.path.realpath(data / "accounts" / a / "vault") for a in ("abc123", "def456")}
                         | {os.path.realpath(data / "vault")}, "and the shared default from before the move")
        listed = [rel for _, rel in backup._files(str(data))]
        self.assertIn("accounts/abc123/notes.json", listed)
        self.assertIn("settings.json", listed)
        self.assertFalse([rel for rel in listed if "/vault" in rel], listed)
        self.assertIn("accounts", backup._entries(str(data)), "the accounts folder itself is replaced by a restore")

    def test_a_restore_keeps_each_accounts_vault_in_place(self):
        source = self.folder("source", "from the backup")
        archive = self.base / "backup.zip"
        with patch.object(backup, "_data_dir", return_value=str(source)):
            backup.make_backup(str(archive), include_keys=True)
        with zipfile.ZipFile(archive) as zipped:
            self.assertFalse([n for n in zipped.namelist() if "/vault/" in n], "no vault in the backup")
        live = self.folder("live", "current")
        (live / "accounts" / "abc123" / "vault" / "Extra.md").write_text("new since the backup", encoding="utf-8")
        (live / ".restore").mkdir()
        shutil.copyfile(archive, live / ".restore" / backup.PENDING)
        result = backup.apply_pending_restore(str(live))
        self.assertTrue(result["ok"], result)
        self.assertEqual((live / "accounts" / "abc123" / "notes.json").read_text(encoding="utf-8"), "from the backup")
        for account in ("abc123", "def456"):
            self.assertEqual((live / "accounts" / account / "vault" / "Note.md").read_text(encoding="utf-8"),
                             f"{account} vault")
        self.assertEqual((live / "accounts" / "abc123" / "vault" / "Extra.md").read_text(encoding="utf-8"),
                         "new since the backup", "the vault is as it was, not as the backup left it")
        safety = Path(result["safety_copy"])
        self.assertFalse((safety / "accounts" / "abc123" / "vault").exists(), "put back, not left in the safety copy")
        self.assertEqual((safety / "accounts" / "abc123" / "notes.json").read_text(encoding="utf-8"), "current")


class ChatsPerAccount(unittest.TestCase):
    """Group 3: each account has its own chats, background work per chat, uploads and activity feed."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)  # layout 3, as app.py leaves it
        assert "sessions.db" in account_migration.moved_names()

    def setUp(self):
        from core import session_manager_store
        self.store = session_manager_store
        self.addCleanup(self.store.close)  # open connections would keep the temp folder's files locked
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))

    def test_a_chat_is_listed_and_found_only_in_its_own_account(self):
        from core.session_manager import session_manager
        with accounts.as_account(self.first):
            chat = session_manager.create_session("first's chat", owner_user="david-darr")
        with accounts.as_account(self.second):
            other = session_manager.create_session("bea's chat", owner_user="bea")
        with accounts.as_account(self.first):
            self.assertEqual([s["id"] for s in session_manager.list_sessions()], [chat["id"]])
            self.assertEqual(session_manager.get_session(chat["id"])["title"], "first's chat")
            self.assertIsNone(session_manager.get_session(other["id"]))
        with accounts.as_account(self.second):
            self.assertEqual([s["id"] for s in session_manager.list_sessions()], [other["id"]])
            self.assertIsNone(session_manager.get_session(chat["id"]))
            self.assertFalse(self.store.session_exists(chat["id"]))

    def test_each_account_has_its_own_database_file_in_its_folder(self):
        from core.session_manager import session_manager
        paths = {}
        for account_id in (self.first, self.second):
            with accounts.as_account(account_id):
                paths[account_id] = self.store.db_file()
                session_manager.create_session("x")
        self.assertNotEqual(*paths.values())
        for account_id, path in paths.items():
            self.assertEqual(path, os.path.join(accounts.ACCOUNTS_DIR, account_id, "sessions.db"))
            self.assertTrue(os.path.exists(path), "created in the account folder")
        self.assertFalse(os.path.exists(os.path.join(_DATA.name, "sessions.db")), "nothing at the shared place")
        self.assertEqual(set(paths.values()) - set(self.store._conns), set(), "one open connection per account")

    def test_only_the_first_admins_database_imports_the_old_json_chats(self):
        mine = os.path.join(accounts.ACCOUNTS_DIR, self.first, "sessions.db")
        theirs = os.path.join(accounts.ACCOUNTS_DIR, self.second, "sessions.db")
        self.assertIsNone(self.store.DB_FILE)
        self.assertTrue(self.store._legacy_owner(mine))
        self.assertFalse(self.store._legacy_owner(theirs))
        self.assertTrue(self.store._legacy_owner(os.path.join(_DATA.name, "sessions.db")), "the shared place, before the move")
        with patch.object(self.store, "DB_FILE", os.path.join(_DATA.name, "own.db")):
            self.assertTrue(self.store._legacy_owner(theirs), "a test's own file is its own legacy owner")

    def test_background_work_is_saved_back_to_the_account_it_was_loaded_from(self):
        from core import chat_tasks
        sid = "bgwork-" + self.first
        self.addCleanup(chat_tasks._sessions.pop, sid, None)
        self.addCleanup(chat_tasks._files.pop, sid, None)
        with accounts.as_account(self.first):
            chat_tasks._session(sid)
            loaded = chat_tasks._files[sid]
        self.assertEqual(loaded, os.path.join(accounts.ACCOUNTS_DIR, self.first, "chat_tasks", sid + ".json"))
        with accounts.as_account(self.second):
            chat_tasks._save(sid)
            self.assertEqual(chat_tasks._path(sid), loaded, "the file it came from, not this account's")
        self.assertTrue(os.path.exists(loaded), "written in the first account's folder")
        self.assertFalse(os.path.exists(os.path.join(accounts.ACCOUNTS_DIR, self.second, "chat_tasks", sid + ".json")))
        with accounts.as_account(self.second):
            chat_tasks.forget(sid)
        self.assertFalse(os.path.exists(loaded))
        self.assertNotIn(sid, chat_tasks._files)
        self.assertNotIn(sid, chat_tasks._sessions)

    def test_a_staged_upload_is_found_only_by_its_own_account(self):
        from core import attachments
        with accounts.as_account(self.first):
            staged = attachments.stage_file("notes.txt", b"hello")
            path, name = attachments.staged_file_info(staged["id"])
            self.assertEqual(name, "notes.txt")
            self.assertEqual(os.path.dirname(path), os.path.join(accounts.ACCOUNTS_DIR, self.first, "attachments"))
        with accounts.as_account(self.second):
            self.assertIsNone(attachments.staged_file_info(staged["id"]))
        with accounts.as_account(self.first):
            self.assertIsNotNone(attachments.staged_file_info(staged["id"]))

    def test_an_event_shows_in_its_own_accounts_feed_only(self):
        from core import events
        with accounts.as_account(self.first):
            events.emit("test.g3", "first's event")
            self.assertEqual([e["message"] for e in events.recent() if e["type"] == "test.g3"], ["first's event"])
        with accounts.as_account(self.second):
            self.assertEqual([e for e in events.recent() if e["type"] == "test.g3"], [])

    def test_an_event_with_nobody_signed_in_is_dropped_quietly(self):
        from core import events
        with accounts.as_account(self.first):
            before = events.recent()
        token = accounts.set_current(None)
        try:
            events.emit("test.nobody", "refused sign-in")  # must not raise
        finally:
            accounts.reset_current(token)
        self.assertFalse(os.path.exists(os.path.join(_DATA.name, "events.json")), "nothing at the shared place")
        for account_id in (self.first, self.second):
            with accounts.as_account(account_id):
                self.assertFalse([e for e in events.recent() if e["type"] == "test.nobody"])
        with accounts.as_account(self.first):
            self.assertEqual(events.recent(), before)

    def test_a_phone_notification_reads_the_chat_from_its_owners_account(self):
        from core.session_manager import session_manager
        from services import mobile_notifications
        with accounts.as_account(self.second):
            chat = session_manager.create_session("bea's chat", owner_user="bea")
        self.assertEqual(mobile_notifications._owners_session("bea", chat["id"])["id"], chat["id"])
        self.assertIsNone(mobile_notifications._owners_session("david-darr", chat["id"]), "not in their chats")
        self.assertIsNone(mobile_notifications._owners_session("deleted-user", chat["id"]), "a user that no longer exists")
        self.assertIsNone(accounts.current_account(), "and the caller's own account is untouched")

    def test_the_watcher_only_forgets_a_chat_when_the_account_that_showed_it_lacks_it(self):
        from services import background_tasks
        sid = "watched-" + self.first
        groups = {sid: dict(helpers=[{"id": "h"}], cards=[], computers=[], apps=[])}
        stale = {"h": {"status": "done", "endedAt": 1}}

        def plant():
            background_tasks._derived[sid] = dict(stale)
            background_tasks._account_of[sid] = self.first

        self.addCleanup(background_tasks._forget_sid, sid)
        with patch.object(background_tasks, "_source_groups", return_value={}), \
                patch.object(background_tasks.store, "session_exists", return_value=False):
            plant()
            background_tasks._tick(self.second)
            self.assertIn(sid, background_tasks._derived, "finished, but another account's: left alone")
            self.assertEqual(background_tasks._account_of[sid], self.first)
            background_tasks._tick(self.first)
            self.assertNotIn(sid, background_tasks._derived, "its own account's watcher does tidy it")
        with patch.object(background_tasks, "_source_groups", return_value=groups), \
                patch.object(background_tasks.store, "session_exists", return_value=False):
            plant()
            background_tasks._tick(self.second)
            self.assertIn(sid, background_tasks._account_of, "a source names it, but this account has no such chat")
            background_tasks._tick(self.first)
            self.assertNotIn(sid, background_tasks._account_of, "gone from the account that showed it")


class ChatsMigration(unittest.TestCase):
    """Migration step 3, and what a backup and restore do with the per-account chat database."""

    STEP3_FILES = ("sessions.db", "sessions.db-wal", "sessions.db-shm", "sessions.db.pre-v6", "sessions.db.pre-v7-wal",
                   "chat_tasks/x.json", "attachments/a_b.txt", "events.json", "agent_conversations.json",
                   "sessions.pre-sqlite-backup/sessions_index.json")
    # The phone database and sign-ins are install-level; the job tab's files are read by the tab's own
    # code at the top of the data folder until tab data moves (group 7).
    SHARED_FILES = ("mobile_activity.db", "sessions.json", "jobs.json", "jobs/resumes/r.txt")

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout3-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name)
        self.account = self.data / "accounts" / "abc123"

    def plant(self, names):
        for name in names:
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name, encoding="utf-8")

    def test_the_chat_files_move_and_the_phone_database_and_logins_stay(self):
        self.plant(self.STEP3_FILES + self.SHARED_FILES)
        (self.data / "layout.json").write_text(json.dumps({"version": 2}), encoding="utf-8")
        step = account_migration.STEPS[2]
        self.assertEqual(step.version, 3)
        result = account_migration.run(str(self.data), [step], account="abc123",
                                       backup=lambda path: Path(path).write_text("backup", encoding="utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["from_version"], result["to_version"]), (2, 3))
        for name in self.STEP3_FILES:
            self.assertEqual((self.account / name).read_text(encoding="utf-8"), name, f"{name} moved")
            self.assertFalse((self.data / name).exists(), f"{name} left the top level")
        for name in ("chat_tasks", "attachments", "sessions.pre-sqlite-backup"):
            self.assertFalse((self.data / name).exists(), f"{name} folder moved whole")
        for name in self.SHARED_FILES:
            self.assertEqual((self.data / name).read_text(encoding="utf-8"), name, f"{name} stays shared")
            self.assertFalse((self.account / name).exists())
        self.assertEqual(account_migration.layout_version(str(self.data)), 3)
        self.assertIn("sessions.db", account_migration.moved_names(str(self.data)))
        self.assertNotIn("mobile_activity.db", account_migration.moved_names(str(self.data)))

    def test_the_wildcard_only_takes_the_database_copies(self):
        self.plant(("sessions.db", "sessions.db.pre-v4", "sessions.dbx", "sessions.json", "sessions.db-journal"))
        self.assertEqual(account_migration._expand(str(self.data), "sessions.db.pre-v*"), ["sessions.db.pre-v4"])
        self.assertEqual(account_migration._expand(str(self.data), "sessions.db"), ["sessions.db"], "no wildcard: as given")
        self.assertEqual(account_migration._expand(str(self.data / "missing"), "sessions.db.pre-v*"), [])

    def test_a_backup_finds_the_stores_at_the_top_and_in_every_account(self):
        self.plant(("sessions.db", "accounts/abc123/sessions.db", "accounts/def456/sessions.db",
                    "accounts/def456/tasks.json", "accounts/ghi789/other.txt"))
        found = backup._store_paths(str(self.data), ("sessions.db", "tasks.json", "triggers.json"))
        shown = sorted((n, os.path.relpath(p, self.data).replace(os.sep, "/")) for n, p in found)
        self.assertEqual(shown, [("sessions.db", "accounts/abc123/sessions.db"),
                                 ("sessions.db", "accounts/def456/sessions.db"), ("sessions.db", "sessions.db"),
                                 ("tasks.json", "accounts/def456/tasks.json")])
        bare = TemporaryDirectory(prefix="kairos-nofolder-", dir=tempfile.gettempdir())
        self.addCleanup(bare.cleanup)
        (Path(bare.name) / "sessions.db").write_text("x", encoding="utf-8")
        self.assertEqual([n for n, _ in backup._store_paths(bare.name, ("sessions.db",))], ["sessions.db"],
                         "no accounts folder yet: just the top level")

    def test_a_restore_settles_unfinished_runs_in_every_accounts_database(self):
        import sqlite3
        from contextlib import closing
        paths = {"account": self.account / "sessions.db", "top": self.data / "sessions.db"}
        for path in paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT)")
                db.executemany("INSERT INTO runs VALUES (?, ?)", [("r1", "running"), ("r2", "done")])
        result = backup.disable_restored_automations(str(self.data))
        self.assertEqual(result["queued"], 2)
        for path in paths.values():
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(dict(db.execute("SELECT id, status FROM runs")), {"r1": "failed", "r2": "done"})


class BotsPerAccount(unittest.TestCase):
    """Group 4: each account has its own bots and its own Kip."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)  # layout 4, as app.py leaves it
        assert "agents.json" in account_migration.moved_names()

    def setUp(self):
        from core import session_manager_store
        self.addCleanup(session_manager_store.close)  # open connections would keep the temp folder's files locked
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))

    def test_a_bot_is_listed_only_in_its_own_account(self):
        from services import agent_service as agent_service_module
        service = agent_service_module.agent_service
        with accounts.as_account(self.first):
            bot = service.create("First bot")
        with accounts.as_account(self.second):
            other = service.create("Second bot")
        with accounts.as_account(self.first):
            self.assertEqual([a["id"] for a in service.list_agents()], [bot["id"]])
            self.assertIsNone(service.get(other["id"]))
        with accounts.as_account(self.second):
            self.assertEqual([a["id"] for a in service.list_agents()], [other["id"]])
            self.assertIsNone(service.get(bot["id"]))

    def test_each_account_keeps_its_bots_in_its_own_folder(self):
        from services import agent_service as agent_service_module
        dirs, files = {}, {}
        for account_id in (self.first, self.second):
            with accounts.as_account(account_id):
                agent_service_module.agent_service.create("A bot")
                dirs[account_id] = agent_service_module.agents_dir()
                files[account_id] = agent_service_module.agents_file()
        self.assertNotEqual(*dirs.values())
        for account_id in (self.first, self.second):
            folder = accounts.account_dir(account_id)
            self.assertEqual(os.path.dirname(files[account_id]), folder)
            self.assertEqual(dirs[account_id], os.path.join(folder, "agents"))
            self.assertTrue(os.path.exists(files[account_id]))

    def test_a_delete_hook_runs_for_a_bot_deleted_in_either_account(self):
        from services import agent_service as agent_service_module
        service = agent_service_module.agent_service
        seen = []
        self.addCleanup(agent_service_module.on_delete(seen.append))
        gone = []
        for account_id in (self.first, self.second):
            with accounts.as_account(account_id):
                bot = service.create("Doomed")
                service.delete(bot["id"])
                gone.append(bot["id"])
                self.assertIsNone(service.get(bot["id"]))
        self.assertEqual(seen, gone)

    def test_each_account_gets_its_own_kip_and_its_own_state_file(self):
        from services import agent_service as agent_service_module, front_desk
        service = agent_service_module.agent_service
        # Kip's welcome cards and the "what I can reach" probe belong to other services: stubbed.
        with patch("services.front_desk_cards.post_card"), patch.object(front_desk, "connections", return_value={}):
            front_desk.ensure_all()
            front_desk.ensure_all()
        ids = {}
        for name, account_id in (("david-darr", self.first), ("bea", self.second)):
            with accounts.as_account(account_id):
                kips = [a for a in service.list_agents() if a.get("builtin") == "front_desk"]
                self.assertEqual(len(kips), 1, "a second start-up makes no second Kip")
                ids[name] = kips[0]["id"]
                state_file = Path(accounts.account_dir(account_id)) / "front_desk" / "state.json"
                self.assertEqual(front_desk._state_file(), state_file)
                self.assertEqual(json.loads(state_file.read_text(encoding="utf-8"))["bot_id"], ids[name])
                self.assertEqual(front_desk.bot_id(), ids[name])
        self.assertNotEqual(*ids.values())
        with accounts.as_account(self.first):
            self.assertIsNone(service.get(ids["bea"]))

    def test_account_owner_is_the_current_accounts_user(self):
        from services import front_desk
        with patch.object(auth, "auth_enabled", return_value=True):
            with accounts.as_account(self.second):
                self.assertEqual(front_desk.account_owner(), "bea")
            with accounts.as_account(self.first):
                self.assertEqual(front_desk.account_owner(), "david-darr")

    def test_legacy_owner_follows_the_account_with_sign_in_on_and_the_local_user_with_it_off(self):
        from services.bot_attention import legacy_owner
        with patch.object(auth, "auth_enabled", return_value=True), accounts.as_account(self.second):
            self.assertEqual(legacy_owner(), "bea")
        with patch.object(auth, "auth_enabled", return_value=False), accounts.as_account(self.second):
            self.assertEqual(legacy_owner(), SINGLE_USER)

    def test_two_bots_each_get_their_own_front_desk_watch_routine(self):
        from services import bot_routines
        from services import agent_service as agent_service_module
        from services.task_service import task_service
        spec = bot_routines.normalize_config({"name": "Watch", "instructions": "Look around.",
                                              "schedule": {"kind": "daily", "time": "09:00", "time_zone": "UTC"}})
        made = {}
        for name, account_id in (("david-darr", self.first), ("bea", self.second)):
            with accounts.as_account(account_id):
                bot = agent_service_module.agent_service.create(f"{name} watcher")
                task = bot_routines.create(name, bot["id"], dict(spec), application_id="front-desk-watch")
                self.addCleanup(task_service.delete_task, task["id"])
                made[name] = (bot["id"], task)
                again = bot_routines.create(name, bot["id"], dict(spec), application_id="front-desk-watch")
                self.assertEqual(again["id"], task["id"], "the same bot asking again gets its own back")
        (first_bot, first_task), (second_bot, second_task) = made.values()
        self.assertNotEqual(first_task["id"], second_task["id"])
        self.assertEqual((first_task["agent_id"], second_task["agent_id"]), (first_bot, second_bot))

    def test_the_routine_runner_starts_up_once_per_account(self):
        from core import bot_routine_runner
        saved = set(bot_routine_runner._started_up)
        self.addCleanup(lambda: (bot_routine_runner._started_up.clear(), bot_routine_runner._started_up.update(saved)))
        bot_routine_runner.start_up_state()
        self.assertEqual(bot_routine_runner._started_up, set())
        with patch.object(bot_routine_runner, "_startup_runs") as startup:
            with accounts.as_account(self.first):
                asyncio.run(bot_routine_runner.tick())
            self.assertEqual(bot_routine_runner._started_up, {self.first}, "only the account that ticked")
            self.assertEqual(startup.call_count, 1)
            with accounts.as_account(self.first):
                asyncio.run(bot_routine_runner.tick())
            self.assertEqual(startup.call_count, 1, "not twice for the same account")
            with accounts.as_account(self.second):
                asyncio.run(bot_routine_runner.tick())
            self.assertEqual(bot_routine_runner._started_up, {self.first, self.second})
            self.assertEqual(startup.call_count, 2, "the second account still gets its own start-up")
            bot_routine_runner.start_up_state()
            self.assertEqual(bot_routine_runner._started_up, set(), "a fresh process starts every account again")

    def test_keep_warm_remembers_the_account_a_chat_belongs_to(self):
        from types import SimpleNamespace
        from services import bot_keep_warm
        self.addCleanup(bot_keep_warm._idle.clear)
        bot = {"id": "b1", "cache_keep_warm": "on"}
        endpoint = {"id": "e1", "kind": "api"}
        brain = SimpleNamespace(_messages=[{"role": "user", "content": "hi"}], tools=[], model="m")
        usage = SimpleNamespace(cache_write_tokens=10)
        with accounts.as_account(self.second):
            bot_keep_warm.observe(bot, "chat-b", endpoint, brain, usage, now=1.0)
        self.assertEqual(bot_keep_warm._idle["chat-b"]["account"], self.second)
        token = accounts.set_current(None)  # nobody signed in
        try:
            bot_keep_warm.observe(bot, "chat-none", endpoint, brain, usage, now=1.0)
        finally:
            accounts.reset_current(token)
        self.assertNotIn("chat-none", bot_keep_warm._idle)

    def test_a_calls_summary_runs_in_its_owners_account_unless_one_is_set(self):
        from services import agent_calls
        call = {"owner": "bea"}
        self.assertIsNone(accounts.current_account())
        with agent_calls._in_owners_account(call):
            self.assertEqual(accounts.current_account(), self.second)
        self.assertIsNone(accounts.current_account())
        with accounts.as_account(self.first), agent_calls._in_owners_account(call):
            self.assertEqual(accounts.current_account(), self.first, "an account already set is left alone")
        with agent_calls._in_owners_account({"owner": "ghost"}):
            self.assertIsNone(accounts.current_account(), "an owner with no account changes nothing")


class BotsMigration(unittest.TestCase):
    """Migration step 4: bots and Kip move into the account folder; install-level bot files stay."""

    INSTALL_LEVEL = ("bot-skills-library/index.json", "bot-secrets/x", "bot-keys.json", "bot-connections/a.json",
                     "bot-resource-settings/k.json", "bot_lifecycle/x", "discord_bots.json", "speech_models/m",
                     "speech_runtime.json", "swarm/swarm.sqlite3", "jobs.json")

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout4-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name)
        self.account = self.data / "accounts" / "abc123"

    def step4_files(self):
        """One concrete file for every entry: a folder's entry gets a file inside it, a wildcard its matches."""
        names = ["bot_rooms.sqlite3-wal", "agents.json.pre-bots", "front_desk/state.json", "agents/inbox.json"]
        for entry in account_migration.STEPS[3].entries:
            if entry.endswith(".*"):
                names.append(entry[:-1] + "pre-bots")
            elif entry.endswith("*"):
                names += [entry[:-1], entry[:-1] + "-wal"]
            elif "." in entry:
                names.append(entry)
            else:
                names.append(entry + "/x.json")
        return sorted(set(names))

    def plant(self, names):
        for name in names:
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name, encoding="utf-8")

    def test_every_bot_name_moves_and_every_install_level_name_stays(self):
        step = account_migration.STEPS[3]
        self.assertEqual(step.version, 4)
        self.plant(self.step4_files() + list(self.INSTALL_LEVEL))
        (self.data / "layout.json").write_text(json.dumps({"version": 3}), encoding="utf-8")
        result = account_migration.run(str(self.data), [step], account="abc123",
                                       backup=lambda path: Path(path).write_text("backup", encoding="utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["from_version"], result["to_version"]), (3, 4))
        for name in self.step4_files():
            self.assertEqual((self.account / name).read_text(encoding="utf-8"), name, f"{name} moved")
            self.assertFalse((self.data / name).exists(), f"{name} left the top level")
        for name in self.INSTALL_LEVEL:
            self.assertEqual((self.data / name).read_text(encoding="utf-8"), name, f"{name} stays at the top")
            self.assertFalse((self.account / name).exists(), f"{name} must not be in the account folder")

    def test_the_wildcards_cover_the_database_copies_and_nothing_install_level(self):
        data = str(self.data)
        (self.data / "layout.json").write_text(json.dumps({"version": 4}), encoding="utf-8")
        account_migration._moved.pop(data, None)
        for name in ("bot_rooms.sqlite3", "bot_rooms.sqlite3-wal", "agents.json.pre-bots", "agents.json", "front_desk"):
            self.assertTrue(account_migration.is_moved(name, data), name)
        for name in ("bot-skills-library", "bot-secrets", "bot-keys.json", "discord_bots.json", "swarm", "jobs.json"):
            self.assertFalse(account_migration.is_moved(name, data), name)
        (self.data / "layout.json").write_text(json.dumps({"version": 3}), encoding="utf-8")
        account_migration._moved.pop(data, None)
        self.assertFalse(account_migration.is_moved("bot_rooms.sqlite3", data), "not before layout 4")
        account_migration._moved.pop(data, None)

    def test_a_bot_database_path_is_in_the_account_folder_once_moved(self):
        account_migration.run(_DATA.name, backup=lambda path: None)
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        account_id = auth_manager.account_id("david-darr")
        self.assertTrue(account_migration.is_moved("bot_rooms.sqlite3"))
        self.assertFalse(account_migration.is_moved("bot-skills-library"))
        with accounts.as_account(account_id):
            self.assertEqual(accounts.path("bot_rooms.sqlite3"),
                             os.path.join(accounts.account_dir(account_id), "bot_rooms.sqlite3"))
            self.assertEqual(accounts.path("bot-skills-library"), os.path.join(_DATA.name, "bot-skills-library"))


class TasksPerAccount(unittest.TestCase):
    """Group 5: each account has its own tasks, cards, routines, hooks and triggers, and the scheduler's lanes."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)  # layout 5, as app.py leaves it
        assert "tasks.json" in account_migration.moved_names()

    def setUp(self):
        from core import session_manager_store
        self.addCleanup(session_manager_store.close)
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))

    def make_task(self, account_id, name="A task"):
        from services.task_service import task_service
        with accounts.as_account(account_id):
            task = task_service.create_task(name, "do it", "interval", interval_seconds=3600)
        self.addCleanup(self.delete_task, account_id, task["id"])
        return task

    @staticmethod
    def delete_task(account_id, task_id):
        from services.task_service import task_service
        with accounts.as_account(account_id):
            task_service.delete_task(task_id)

    @staticmethod
    def delete_hook(account_id, hook_id):
        from services.hook_service import hook_service
        with accounts.as_account(account_id):
            hook_service.delete(hook_id)

    @staticmethod
    def delete_trigger(account_id, trigger_id):
        from services.trigger_service import trigger_service
        with accounts.as_account(account_id):
            trigger_service.delete(trigger_id)

    def test_a_task_is_listed_only_in_its_own_account(self):
        from services.task_service import task_service
        task = self.make_task(self.first, "First's task")
        with accounts.as_account(self.first):
            self.assertIn(task["id"], [t["id"] for t in task_service.list_tasks()])
            self.assertIsNotNone(task_service.get_task(task["id"]))
        with accounts.as_account(self.second):
            self.assertNotIn(task["id"], [t["id"] for t in task_service.list_tasks()])
            self.assertIsNone(task_service.get_task(task["id"]))

    def test_the_task_and_run_files_sit_in_each_account_folder(self):
        from services import task_service as task_module
        self.make_task(self.first)
        self.make_task(self.second)
        for account_id in (self.first, self.second):
            with accounts.as_account(account_id):
                folder = accounts.account_dir(account_id)
                self.assertEqual(task_module.tasks_file(), os.path.join(folder, "tasks.json"))
                self.assertEqual(task_module.runs_file(), os.path.join(folder, "task_runs.json"))
                self.assertTrue(os.path.exists(task_module.tasks_file()), "created in the account folder")
        self.assertFalse(os.path.exists(os.path.join(_DATA.name, "tasks.json")), "nothing at the shared place")

    def test_a_test_can_still_point_the_tasks_at_its_own_file(self):
        from services import task_service as task_module
        own = os.path.join(_DATA.name, "own-tasks", "tasks.json")
        with patch.object(task_module, "TASKS_FILE", own):
            self.assertEqual(task_module.tasks_file(), own)
            self.assertEqual(task_module.runs_file(), os.path.join(os.path.dirname(own), "task_runs.json"),
                             "the run history is its sibling")
            with accounts.as_account(self.second):
                self.assertEqual(task_module.tasks_file(), own, "whatever the account")

    def test_a_hook_is_listed_only_in_its_own_account(self):
        from services.hook_service import hook_service
        with accounts.as_account(self.first):
            hook = hook_service.create("First's hook", event="chat.reply", action="vault_note",
                                       config={"path": "Logs/x.md"})
            self.addCleanup(self.delete_hook, self.first, hook["id"])
            self.assertEqual([h["id"] for h in hook_service.hooks()], [hook["id"]])
            self.assertTrue(os.path.exists(os.path.join(accounts.account_dir(), "hooks.json")))
        with accounts.as_account(self.second):
            self.assertEqual(hook_service.hooks(), [])
            self.assertIsNone(hook_service.get(hook["id"]))

    def test_a_listener_added_in_one_account_hears_every_accounts_events(self):
        from services import hook_service as hook_module
        service = hook_module.hook_service
        heard = []
        listener = lambda event, data: heard.append(event)
        with accounts.as_account(self.first):
            service.subscribe(listener)
        self.addCleanup(service.unsubscribe, listener)
        with accounts.as_account(self.second):
            self.assertIn(listener, service.current()._listeners)
            self.assertIs(service.current()._listeners, hook_module._LISTENERS)
            service.current()._notify_listeners("chat.reply", {})
        self.assertEqual(heard, ["chat.reply"])

    def test_a_trigger_is_found_by_the_account_that_owns_it(self):
        from services.trigger_service import owning_account, trigger_service
        with accounts.as_account(self.second):
            trigger, _secret = trigger_service.create("Bea's trigger")
        self.addCleanup(self.delete_trigger, self.second, trigger["id"])
        with accounts.as_account(self.first):
            self.assertIsNone(trigger_service.get(trigger["id"]))
        self.assertTrue(os.path.exists(os.path.join(accounts.account_dir(self.second), "triggers.json")))
        self.assertIsNone(accounts.current_account())
        with owning_account(trigger["id"]):
            self.assertEqual(accounts.current_account(), self.second)
            self.assertIsNotNone(trigger_service.get(trigger["id"]))
        self.assertIsNone(accounts.current_account())
        with owning_account("no-such-trigger"):
            self.assertEqual(accounts.current_account(), accounts.local_account())
            self.assertEqual(accounts.current_account(), self.first, "the first admin's, as before")

    def test_each_account_has_its_own_scheduler_lanes(self):
        from core import task_scheduler
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        pending = loop.create_future()
        saved = dict(task_scheduler._lanes)
        self.addCleanup(lambda: (task_scheduler._lanes.clear(), task_scheduler._lanes.update(saved)))
        task_scheduler._lanes[(self.first, "card")] = pending
        self.assertFalse(task_scheduler._lane_free("card", self.first), "busy in the first account")
        self.assertTrue(task_scheduler._lane_free("card", self.second), "free in the second")
        self.assertTrue(task_scheduler._lane_free("schedule", self.first), "another lane of the same account")
        self.assertIs(task_scheduler.lane("card", self.first), pending)
        self.assertIsNone(task_scheduler.lane("card", self.second))
        with accounts.as_account(self.first):
            self.assertIs(task_scheduler.lane("card"), pending, "the current account's by default")
        with accounts.as_account(self.second):
            self.assertIsNone(task_scheduler.lane("card"))
        pending.set_result(None)
        self.assertTrue(task_scheduler._lane_free("card", self.first), "free again once it is done")

    def test_schedules_are_migrated_in_every_account_but_built_ins_switch_on_in_the_local_one(self):
        from core import builtin_tasks
        seen = []
        with patch.object(builtin_tasks, "_migrate_schedules",
                          side_effect=lambda: seen.append(accounts.current_account()) or 1):
            self.assertEqual(builtin_tasks.migrate_builtin_schedules(), 2, "the counts add up")
        self.assertEqual(sorted(seen), sorted([self.first, self.second]))
        seen.clear()
        with patch.object(builtin_tasks, "_autoenable",
                          side_effect=lambda: seen.append(accounts.current_account()) or ["sync_all"]):
            turned_on = builtin_tasks.autoenable_builtins()
        # Every account since group 6 (mail and synced sources are per account now).
        self.assertEqual(sorted(seen), sorted(accounts.all_accounts()))
        self.assertEqual(turned_on, ["sync_all"] * len(accounts.all_accounts()))


class TasksMigration(unittest.TestCase):
    """Migration step 5: tasks, routines, triggers and hooks move into the account folder."""

    MOVES = ("tasks.json", "tasks.json.pre-routines.bak", "task_runs.json", "triggers.json", "hooks.json")
    STAYS = ("google_workspace.json", "jobs.json", "settings.json")

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout5-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name)
        self.account = self.data / "accounts" / "abc123"

    def test_the_task_stores_move_and_the_rest_stays(self):
        for name in self.MOVES + self.STAYS:
            (self.data / name).write_text(name, encoding="utf-8")
        (self.data / "layout.json").write_text(json.dumps({"version": 4}), encoding="utf-8")
        step = account_migration.STEPS[4]
        self.assertEqual(step.version, 5)
        result = account_migration.run(str(self.data), [step], account="abc123",
                                       backup=lambda path: Path(path).write_text("backup", encoding="utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["from_version"], result["to_version"]), (4, 5))
        for name in self.MOVES:
            self.assertEqual((self.account / name).read_text(encoding="utf-8"), name, f"{name} moved")
            self.assertFalse((self.data / name).exists(), f"{name} left the top level")
        for name in self.STAYS:
            self.assertEqual((self.data / name).read_text(encoding="utf-8"), name, f"{name} stays at the top")
            self.assertFalse((self.account / name).exists(), f"{name} must not be in the account folder")
        self.assertEqual(account_migration.layout_version(str(self.data)), 5)
        self.assertTrue(account_migration.is_moved("tasks.json.pre-routines.bak", str(self.data)))
        self.assertFalse(account_migration.is_moved("google_workspace.json", str(self.data)))
        account_migration._moved.pop(str(self.data), None)


class MailAndSettingsPerAccount(unittest.TestCase):
    """Group 6: mail, its triage, standing permissions and integrations are each account's own."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)  # layout 6, as app.py leaves it
        assert "email_accounts.json" in account_migration.moved_names()

    def setUp(self):
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))

    def folder(self, account_id, name):
        return os.path.join(accounts.ACCOUNTS_DIR, account_id, name)

    def forget_file(self, account_id, name):
        self.addCleanup(lambda: Path(self.folder(account_id, name)).unlink(missing_ok=True))

    def test_a_mail_account_is_listed_only_under_the_account_that_added_it(self):
        from core import email_triage
        from services import email_service as mail
        for account_id in (self.first, self.second):
            self.forget_file(account_id, "email_accounts.json")
        self.addCleanup(mail.email_service.forget)  # its instances were built from files that are gone after this
        with accounts.as_account(self.first):
            added = mail.email_service.create_account("david@example.test", "pw", "imap.example.test", 993,
                                                      "smtp.example.test", 465)
            self.assertEqual([a["id"] for a in mail.email_service.list_accounts()], [added["id"]])
            self.assertEqual(mail.accounts_file(), self.folder(self.first, "email_accounts.json"))
            self.assertEqual(email_triage.triage_file(), self.folder(self.first, "email_triage.json"))
        with accounts.as_account(self.second):
            self.assertEqual(mail.email_service.list_accounts(), [])
            self.assertIsNone(mail.email_service.get_account(added["id"]))
            self.assertEqual(mail.accounts_file(), self.folder(self.second, "email_accounts.json"))
            self.assertEqual(email_triage.triage_file(), self.folder(self.second, "email_triage.json"))
        self.assertTrue(os.path.exists(self.folder(self.first, "email_accounts.json")))
        self.assertFalse(os.path.exists(os.path.join(_DATA.name, "email_accounts.json")), "not at the shared place")

    def test_triage_results_are_kept_per_account(self):
        from core import email_triage
        self.forget_file(self.first, "email_triage.json")
        with accounts.as_account(self.first):
            email_triage.save([{"subject": "first's mail"}], 1)
        with accounts.as_account(self.second):
            self.assertEqual(email_triage.load()["items"], [])
        with accounts.as_account(self.first):
            self.assertEqual(email_triage.load()["items"], [{"subject": "first's mail"}])

    def test_a_standing_grant_is_in_the_granting_accounts_rules_only(self):
        from core import permissions
        for account_id in (self.first, self.second):
            self.forget_file(account_id, "permissions.json")
        with accounts.as_account(self.first):
            permissions.grant_standing(["Read"], "david-darr")
            self.assertIn("Read", permissions.standing_grants())
            self.assertEqual(permissions.permissions_file(), self.folder(self.first, "permissions.json"))
        with accounts.as_account(self.second):
            self.assertNotIn("Read", permissions.standing_grants())
            self.assertNotIn("Read", [rule["tool"] for rule in permissions.list_rules()])
            self.assertEqual(permissions.permissions_file(), self.folder(self.second, "permissions.json"))
        self.assertTrue(os.path.exists(self.folder(self.first, "permissions.json")))

    def test_an_integration_is_listed_only_under_the_account_that_made_it(self):
        from core import integrations
        for account_id in (self.first, self.second):
            self.forget_file(account_id, "integrations.json")
        with accounts.as_account(self.first):
            feed = integrations.create_ical_feed("First's feed", "https://example.test/first.ics")
            service = integrations.create_api_service("First's API", "https://api.example.test", "key-1")
            self.assertEqual(integrations.integrations_file(), self.folder(self.first, "integrations.json"))
            self.assertEqual({i["id"] for i in integrations.list_integrations()}, {feed["id"], service["id"]})
        with accounts.as_account(self.second):
            self.assertEqual(integrations.list_integrations(), [])
            self.assertIsNone(integrations.get_integration(feed["id"]))
            self.assertEqual(integrations.integrations_file(), self.folder(self.second, "integrations.json"))
        self.assertFalse(os.path.exists(os.path.join(_DATA.name, "integrations.json")))


class GoogleSplitPerAccount(unittest.TestCase):
    """Group 6: the OAuth app is shared; each account's Google sign-ins are its own."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)

    def setUp(self):
        from core import google_workspace
        self.gw = google_workspace
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))
        self.shared_dir = TemporaryDirectory(prefix="kairos-google-", dir=tempfile.gettempdir())
        self.addCleanup(self.shared_dir.cleanup)
        self.shared = Path(self.shared_dir.name) / "google_workspace.json"
        patcher = patch.object(self.gw, "FILE", str(self.shared))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.files = {n: Path(accounts.ACCOUNTS_DIR) / a / "google_accounts.json"
                      for n, a in (("first", self.first), ("second", self.second))}
        for path in self.files.values():
            path.unlink(missing_ok=True)
            self.addCleanup(lambda p=path: p.unlink(missing_ok=True))

    @staticmethod
    def read(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def test_the_first_admins_sign_ins_move_out_of_the_shared_file_when_it_loads(self):
        david = {"id": "g1", "email": "david@example.test", "refresh_token": "r"}
        self.shared.write_text(json.dumps({"client_id": "app-id", "client_secret": "app-secret",
                                           "accounts": {"g1": david}, "default_account": "g1"}), encoding="utf-8")
        with accounts.as_account(self.first):
            data = self.gw._load()
            self.assertEqual(self.gw._accounts_file(), str(self.files["first"]))
        self.assertEqual(data["client_id"], "app-id")
        self.assertEqual(data["accounts"], {"g1": david})
        self.assertEqual(data["default_account"], "g1")
        self.assertEqual(self.read(self.files["first"]), {"accounts": {"g1": david}, "default_account": "g1"})
        self.assertEqual(self.read(self.shared), {"client_id": "app-id", "client_secret": "app-secret"},
                         "only the app is left in the shared file")

    def test_another_account_sees_the_app_but_none_of_the_first_admins_sign_ins(self):
        self.shared.write_text(json.dumps({"client_id": "app-id", "client_secret": "app-secret",
                                           "accounts": {"g1": {"id": "g1"}}, "default_account": "g1"}),
                               encoding="utf-8")
        with accounts.as_account(self.second):
            data = self.gw._load()
        self.assertEqual(data["client_id"], "app-id")
        self.assertNotIn("accounts", data)
        self.assertNotIn("default_account", data)
        self.assertFalse(self.files["second"].exists(), "loading writes nothing for bea")
        self.assertIn("accounts", self.read(self.shared), "and nothing left the shared file: not bea's to take")

    def test_a_save_by_another_account_goes_to_its_own_file_and_keeps_the_app(self):
        self.shared.write_text(json.dumps({"client_id": "app-id", "client_secret": "app-secret"}), encoding="utf-8")
        bea = {"id": "b1", "email": "bea@example.test"}
        with accounts.as_account(self.second):
            data = self.gw._load()
            data["accounts"] = {"b1": bea}
            data["default_account"] = "b1"
            self.gw._save(data)
            self.assertEqual(self.gw._load()["accounts"], {"b1": bea})
        self.assertEqual(self.read(self.files["second"]), {"accounts": {"b1": bea}, "default_account": "b1"})
        self.assertEqual(self.read(self.shared), {"client_id": "app-id", "client_secret": "app-secret"})
        with accounts.as_account(self.first):
            self.assertNotIn("accounts", self.gw._load(), "bea's sign-in is not the first admin's")

    def test_a_sign_in_remembers_the_account_that_started_it(self):
        self.shared.write_text(json.dumps({"client_id": "app-id"}), encoding="utf-8")
        with accounts.as_account(self.second):
            url = self.gw.start_sign_in("http://127.0.0.1:8000/api/google/oauth/callback", owner="bea")
        state = url.split("state=")[1].split("&")[0]
        self.addCleanup(self.gw._pending.pop, state, None)
        self.assertEqual(self.gw.pending_account(state), self.second)
        self.assertIsNone(self.gw.pending_account("unknown"))


class DiscordAndConnectorsPerAccount(unittest.TestCase):
    """Group 6: bots and connectors stay one file per install; each record names the account it answers as."""

    @classmethod
    def setUpClass(cls):
        account_migration.run(_DATA.name, backup=lambda path: None)

    def setUp(self):
        from core import discord_bots_store
        from core.connectors import KINDS, store as connector_store
        self.bots, self.connectors, self.kind = discord_bots_store, connector_store, KINDS["teams"]
        fresh_users()
        auth_manager.create_user("david-darr", "password-one-1", is_admin=True)
        auth_manager.create_user("bea", "password-two-2")
        self.first, self.second = (auth_manager.account_id(n) for n in ("david-darr", "bea"))
        self.temp = TemporaryDirectory(prefix="kairos-bots-", dir=tempfile.gettempdir())
        self.addCleanup(self.temp.cleanup)
        for owner, name, filename in ((discord_bots_store, "BOTS_FILE", "discord_bots.json"),
                                      (connector_store, "CONNECTORS_FILE", "connectors.json")):
            patcher = patch.object(owner, name, os.path.join(self.temp.name, filename))
            patcher.start()
            self.addCleanup(patcher.stop)

    def make_connector(self, account_id, name="Bea's Teams"):
        with accounts.as_account(account_id):
            return self.connectors.create("teams", name, {"webhook_url": "https://hook.example.test/x"},
                                          self.kind.fields, ["me"], False, None)

    def test_a_bot_records_the_account_that_made_it(self):
        with accounts.as_account(self.second):
            bot = self.bots.create_bot("Bea's bot", "fake-token", allowed_user_id="42")
        self.assertEqual(bot["account"], self.second)
        record = self.bots.get_bot(bot["id"])
        self.assertEqual(record["account"], self.second)
        self.assertEqual(self.bots.account_of(record), self.second)
        with accounts.as_account(self.second):
            self.assertTrue(self.bots.mine(record))
        with accounts.as_account(self.first):
            self.assertFalse(self.bots.mine(record))
        token = accounts.set_current(None)
        try:
            self.assertFalse(self.bots.mine(record), "nobody signed in owns nothing")
        finally:
            accounts.reset_current(token)

    def test_a_bot_from_before_accounts_belongs_to_the_local_user(self):
        legacy = {"id": "legacy1", "name": "Old bot", "token_encrypted": "x"}
        self.assertEqual(self.bots.account_of(legacy), accounts.local_account())
        self.assertEqual(self.bots.account_of(legacy), self.first, "the first admin")
        with accounts.as_account(self.first):
            self.assertTrue(self.bots.mine(legacy))
        with accounts.as_account(self.second):
            self.assertFalse(self.bots.mine(legacy))
        self.assertEqual(self.bots._masked(legacy)["account"], self.first)

    def test_the_channel_list_shows_only_the_current_accounts_bots_and_connectors(self):
        from core.channels import registry
        with accounts.as_account(self.first):
            mine = self.bots.create_bot("First bot", "fake-token")
            self.bots.add_channel(mine["id"], "1001", "firsts-room", "normal")
        with accounts.as_account(self.second):
            theirs = self.bots.create_bot("Bea bot", "fake-token")
            entry = self.bots.add_channel(theirs["id"], "2002", "beas-room", "normal")["channels"][0]
        theirs_id = f"discord:{theirs['id']}:{entry['id']}"
        made = self.make_connector(self.second)

        def ids():
            return {c["id"] for c in registry.list_channels()}
        with accounts.as_account(self.first):
            self.assertNotIn(theirs_id, ids(), "another account's named channel is not a delivery target")
            self.assertTrue(any(i.startswith(f"discord:{mine['id']}:") for i in ids()))
            self.assertNotIn(f"conn:{made['id']}", ids())
        with accounts.as_account(self.second):
            self.assertIn(theirs_id, ids())
            self.assertFalse(any(i.startswith(f"discord:{mine['id']}:") for i in ids()))
            self.assertIn(f"conn:{made['id']}", ids())

    def test_a_connector_records_its_account_and_mine_follows_it(self):
        record = self.make_connector(self.second)
        self.assertEqual(record["account"], self.second)
        self.assertEqual(self.connectors.get_record(record["id"])["account"], self.second)
        self.assertEqual(self.connectors.account_of(record), self.second)
        with accounts.as_account(self.second):
            self.assertTrue(self.connectors.mine(record))
        with accounts.as_account(self.first):
            self.assertFalse(self.connectors.mine(record))
        legacy = {key: value for key, value in record.items() if key != "account"}
        self.assertEqual(self.connectors.account_of(legacy), accounts.local_account(), "a legacy one is the local user's")
        with accounts.as_account(self.first):
            self.assertTrue(self.connectors.mine(legacy))

    def test_a_connector_delivers_only_for_the_account_it_answers_as(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from core.connectors import hub
        record = {"id": "c1", "name": "First's", "kind": "teams", "account": self.first}
        adapter = SimpleNamespace(record=record, default_target="room")
        sent = AsyncMock()
        with patch.object(hub, "adapters", {"c1": adapter}), patch.object(hub, "send_reply", sent):
            with accounts.as_account(self.second):
                self.assertFalse(asyncio.run(hub.deliver("c1", "hello")))
            sent.assert_not_awaited()
            with accounts.as_account(self.first):
                self.assertTrue(asyncio.run(hub.deliver("c1", "hello")))
            sent.assert_awaited_once_with(adapter, "room", "hello")

    def test_a_message_runs_as_the_connectors_account(self):
        from types import SimpleNamespace
        from core.connectors import hub
        from core.connectors.base import Inbound
        seen = []

        async def fake_receive(adapter, inbound):
            seen.append(accounts.current_account())
        adapter = SimpleNamespace(record={"id": "c2", "name": "Bea's", "account": self.second})
        with patch.object(hub, "_receive", fake_receive):
            asyncio.run(hub.receive(adapter, Inbound(conversation="c", sender="s", text="hi")))
        self.assertEqual(seen, [self.second])


class MailMigration(unittest.TestCase):
    """Migration step 6: mail, triage, permissions, integrations and Google sign-ins move."""

    MOVES = ("email_accounts.json", "email_triage.json", "permissions.json", "integrations.json",
             "google_accounts.json")
    STAYS = ("google_workspace.json", "discord_bots.json", "connectors.json", "github-account.json",
             "creative-connections.json")

    def setUp(self):
        self.root = TemporaryDirectory(prefix="kairos-layout6-", dir=tempfile.gettempdir())
        self.addCleanup(self.root.cleanup)
        self.data = Path(self.root.name)
        self.account = self.data / "accounts" / "abc123"

    def test_the_mail_stores_move_and_the_install_level_files_stay(self):
        for name in self.MOVES + self.STAYS:
            (self.data / name).write_text(name, encoding="utf-8")
        (self.data / "layout.json").write_text(json.dumps({"version": 5}), encoding="utf-8")
        step = account_migration.STEPS[5]
        self.assertEqual(step.version, 6)
        result = account_migration.run(str(self.data), [step], account="abc123",
                                       backup=lambda path: Path(path).write_text("backup", encoding="utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["from_version"], result["to_version"]), (5, 6))
        for name in self.MOVES:
            self.assertEqual((self.account / name).read_text(encoding="utf-8"), name, f"{name} moved")
            self.assertFalse((self.data / name).exists(), f"{name} left the top level")
        for name in self.STAYS:
            self.assertEqual((self.data / name).read_text(encoding="utf-8"), name, f"{name} stays at the top")
            self.assertFalse((self.account / name).exists(), f"{name} must not be in the account folder")
        self.assertEqual(account_migration.layout_version(str(self.data)), 6)
        self.assertTrue(account_migration.is_moved("integrations.json", str(self.data)))
        self.assertFalse(account_migration.is_moved("google_workspace.json", str(self.data)))
        account_migration._moved.pop(str(self.data), None)


if __name__ == "__main__":
    unittest.main()
