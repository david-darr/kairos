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
        self.assertEqual([s.version for s in account_migration.STEPS], [1, 2, 3], "group 3 added the chats step")
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
            self.assertEqual(accounts.path("tasks.json"), os.path.join(_DATA.name, "tasks.json"),
                             "routines have not moved yet")

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


if __name__ == "__main__":
    unittest.main()
