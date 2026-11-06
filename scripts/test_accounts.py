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
import unittest
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
        self.assertEqual([s.version for s in account_migration.STEPS], [1])
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
            self.assertEqual(accounts.path("sessions.db"), os.path.join(_DATA.name, "sessions.db"),
                             "chats have not moved yet")

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


if __name__ == "__main__":
    unittest.main()
