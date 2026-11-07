"""Browse's password keeper (services/browse_passwords.py, routes/browse_routes.py /passwords).

- Saved per account, in the account's secrets folder, encrypted with the account's own key: nothing readable
  on disk, and another account's key can't open it.
- A password leaves only for its exact origin (fill), or after the person re-entered their password (reveal).
- The desktop routes (match, fill, save) need the desktop app's secret as well as the sign-in.
- Chrome-style CSV import, the never-save list, the strong-password generator.
- The routes stay cookie-only (no paired terminal).
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
environment = tempfile.TemporaryDirectory(prefix="kairos-browse-pw-")
os.environ["JARVIS_DATA_DIR"] = environment.name

import httpx
from fastapi import FastAPI

from core import accounts, cli_access, middleware, secret_storage
from core.auth import SINGLE_USER
from routes import bot_approval_routes, browse_routes
from services import browse_passwords as pw

ALICE, BOB = "alice1", "bobby2"


def tearDownModule():
    environment.cleanup()


def file_of(account_id):
    return os.path.join(accounts.account_dir(account_id), "bot-secrets", pw.FILE)


class StoreTests(unittest.TestCase):
    def setUp(self):
        for account_id in (ALICE, BOB):
            shutil.rmtree(accounts.account_dir(account_id), ignore_errors=True)
        pw._unlocked.clear()

    def test_saved_per_account_and_encrypted_with_the_account_key(self):
        with accounts.as_account(ALICE):
            row = pw.save("https://example.com/login?next=/", "alice@example.com", "Sup3r-secret!")
            self.assertEqual(row["origin"], "https://example.com")
            self.assertNotIn("password", row)
        with open(file_of(ALICE), "rb") as f:
            raw = f.read()
        for plain in (b"Sup3r-secret!", b"alice@example.com", b"example.com"):
            self.assertNotIn(plain, raw, "nothing readable on disk")
        self.assertEqual(secret_storage.decrypt_for(ALICE, raw.decode()).count("Sup3r-secret!"), 1)
        with accounts.as_account(BOB):
            self.assertEqual(pw.list_logins(), [], "another account sees none of them")
            self.assertEqual(pw.match("https://example.com/")["logins"], [])
            with self.assertRaises(pw.PasswordError):
                pw.fill(row["id"], "https://example.com/")
        # Alice's file copied into Bob's folder: Bob's key can't open it, and it fails closed.
        os.makedirs(os.path.dirname(file_of(BOB)), exist_ok=True)
        shutil.copyfile(file_of(ALICE), file_of(BOB))
        with accounts.as_account(BOB):
            with self.assertRaises(pw.PasswordError) as caught:
                pw.list_logins()
            self.assertEqual(caught.exception.status, 503)
            with self.assertRaises(pw.PasswordError):
                pw.save("https://other.test", "b", "x")
        with open(file_of(BOB), "rb") as f:
            self.assertEqual(f.read(), raw, "an unreadable file is never overwritten")

    def test_fill_only_for_the_exact_origin(self):
        with accounts.as_account(ALICE):
            login_id = pw.save("https://x.com/i/flow/login", "al", "pw-1")["id"]
            self.assertEqual(pw.fill(login_id, "https://x.com/home"), {"username": "al", "password": "pw-1"})
            for other in ("https://mobile.x.com/", "http://x.com/", "https://x.com:8443/", "https://evil.test/?u=https://x.com",
                          "https://x.com.evil.test/", "javascript:alert(1)", "file:///C:/x"):
                with self.assertRaises(pw.PasswordError, msg=other):
                    pw.fill(login_id, other)
            self.assertEqual(pw.match("https://x.com/settings")["logins"][0]["times_used"], 1)
            self.assertEqual(pw.match("https://mobile.x.com/")["logins"], [])

    def test_same_site_and_username_updates_instead_of_adding(self):
        with accounts.as_account(ALICE):
            first = pw.save("https://a.test", "me", "one")
            second = pw.save("https://a.test/", "me", "two")
            self.assertEqual(first["id"], second["id"])
            self.assertTrue(pw.is_saved("https://a.test", "me", "two"))
            self.assertFalse(pw.is_saved("https://a.test", "me", "one"))
            pw.save("https://a.test", "you", "three")
            self.assertEqual(len(pw.list_logins()), 2)
            self.assertEqual(len(pw.list_logins("you")), 1)

    def test_edit_delete_and_reveal_after_unlock(self):
        with accounts.as_account(ALICE):
            login_id = pw.save("https://a.test", "me", "one")["id"]
            with self.assertRaises(pw.PasswordError):
                pw.reveal(login_id)
            pw.unlock(ALICE, True)
            self.assertEqual(pw.reveal(login_id), "one")
            pw.update(login_id, username="me2", password="two")
            self.assertEqual(pw.reveal(login_id), "two")
            pw.lock(ALICE)
            with self.assertRaises(pw.PasswordError):
                pw.reveal(login_id)
            with self.assertRaises(pw.PasswordError):
                pw.unlock(ALICE, False)
            self.assertTrue(pw.delete(login_id))
            self.assertFalse(pw.delete(login_id))
        with accounts.as_account(BOB):
            self.assertIsNone(pw.unlocked_until(BOB))

    def test_never_list(self):
        with accounts.as_account(ALICE):
            pw.set_never("https://bank.test/login", True)
            self.assertTrue(pw.match("https://bank.test/")["never"])
            pw.save("https://bank.test", "me", "x")  # saving by hand takes it off the list
            self.assertFalse(pw.match("https://bank.test/")["never"])

    def test_import_chrome_and_firefox_exports(self):
        chrome = ("name,url,username,password,note\n"
                  "x.com,https://x.com/i/flow/login,al,pw-x,\n"
                  "bad,ftp://files.test,al,pw,\n"
                  "empty,https://e.test,al,,\n"
                  "a,https://a.test/,me,pw-a,hello\n")
        firefox = ('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated"\n'
                   '"https://a.test","me","pw-a2",,"https://a.test","{1}","1"\n')
        with accounts.as_account(ALICE):
            self.assertEqual(pw.import_csv(chrome), {"added": 2, "updated": 0, "unchanged": 0, "skipped": 2})
            self.assertEqual(pw.import_csv(chrome)["unchanged"], 2)
            self.assertEqual(pw.import_csv(firefox)["updated"], 1)
            self.assertTrue(pw.is_saved("https://a.test", "me", "pw-a2"))
            with self.assertRaises(pw.PasswordError):
                pw.import_csv("hello,world\n1,2\n")

    def test_generated_passwords_are_strong(self):
        seen = set()
        for _ in range(50):
            value = pw.generate()
            self.assertEqual(len(value), pw.GENERATED_LENGTH)
            self.assertTrue(any(c.islower() for c in value) and any(c.isupper() for c in value))
            self.assertTrue(any(c.isdigit() for c in value) and any(c in pw._SYMBOLS for c in value))
            seen.add(value)
        self.assertEqual(len(seen), 50)

    def test_origins(self):
        self.assertEqual(pw.origin_of("HTTPS://Example.COM:443/a"), "https://example.com")
        self.assertEqual(pw.origin_of("http://localhost:5173/x"), "http://localhost:5173")
        for bad in ("about:blank", "data:text/html,x", "", None, "https://", "chrome://settings"):
            self.assertIsNone(pw.origin_of(bad), bad)


SECRET = "desktop-secret-for-tests"


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        shutil.rmtree(accounts.account_dir(accounts.local_account()), ignore_errors=True)
        pw._unlocked.clear()
        browse_routes._failed_unlocks.clear()
        self.app = FastAPI()
        self.app.include_router(browse_routes.router)
        self.app.dependency_overrides[middleware.require_user] = lambda: SINGLE_USER
        self.secret = patch.object(bot_approval_routes, "DESKTOP_SECRET", SECRET)
        self.secret.start()

    async def asyncTearDown(self):
        self.secret.stop()

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 5000)), base_url="http://browse")

    async def test_profile_is_default_for_the_first_admin(self):
        async with self.client() as client:
            self.assertEqual((await client.get("/api/browse/profile")).json(), {"profile": "default"})
        with patch.object(accounts, "account_for_user", lambda user: "bea123456789"):
            async with self.client() as client:
                self.assertEqual((await client.get("/api/browse/profile")).json(), {"profile": "bea123456789"})

    async def test_desktop_routes_need_the_desktop_secret(self):
        body = {"url": "https://a.test/", "username": "me", "password": "pw"}
        async with self.client() as client:
            self.assertEqual((await client.post("/api/browse/passwords/desktop/save", json=body)).status_code, 404)
            wrong = await client.post("/api/browse/passwords/desktop/save", json=body, headers={"X-Kairos-Desktop": "nope"})
            self.assertEqual(wrong.status_code, 404)
            tool = await client.post("/api/browse/passwords/desktop/save", json=body,
                                     headers={"X-Kairos-Desktop": SECRET, "X-JARVIS-Tool-Token": "t"})
            self.assertEqual(tool.status_code, 403)
            saved = await client.post("/api/browse/passwords/desktop/save", json=body, headers={"X-Kairos-Desktop": SECRET})
            self.assertEqual(saved.status_code, 200, saved.text)
            login_id = saved.json()["id"]
            self.assertNotIn("pw", saved.text.replace('"pw"', ""))
            known = await client.post("/api/browse/passwords/desktop/known", json=body, headers={"X-Kairos-Desktop": SECRET})
            self.assertEqual(known.json(), {"saved": True, "never": False, "update": True})
            fill = {"id": login_id, "url": "https://a.test/login"}
            self.assertEqual((await client.post("/api/browse/passwords/desktop/fill", json=fill)).status_code, 404)
            got = await client.post("/api/browse/passwords/desktop/fill", json=fill, headers={"X-Kairos-Desktop": SECRET})
            self.assertEqual(got.json(), {"username": "me", "password": "pw"})
            other = await client.post("/api/browse/passwords/desktop/fill", json={"id": login_id, "url": "https://b.test/"},
                                      headers={"X-Kairos-Desktop": SECRET})
            self.assertEqual(other.status_code, 403)
        with patch.object(bot_approval_routes, "DESKTOP_SECRET", None):
            async with self.client() as client:
                none = await client.post("/api/browse/passwords/desktop/fill", json=fill, headers={"X-Kairos-Desktop": SECRET})
                self.assertEqual(none.status_code, 404, "a backend the desktop app didn't start has no desktop routes")

    async def test_desktop_routes_refuse_a_remote_caller(self):
        remote = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("10.0.0.5", 5000)), base_url="http://browse")
        async with remote as client:
            response = await client.post("/api/browse/passwords/desktop/match", json={"url": "https://a.test"},
                                         headers={"X-Kairos-Desktop": SECRET})
        self.assertEqual(response.status_code, 403)

    async def test_manager_lists_without_passwords_and_reveals_after_the_password(self):
        async with self.client() as client:
            added = await client.post("/api/browse/passwords", json={"url": "https://a.test", "username": "me", "password": "hunter2-xyz"})
            login_id = added.json()["id"]
            listing = await client.get("/api/browse/passwords")
            self.assertNotIn("hunter2-xyz", listing.text)
            self.assertEqual(listing.json()["logins"][0]["origin"], "https://a.test")
            self.assertEqual((await client.post(f"/api/browse/passwords/{login_id}/reveal")).status_code, 403)
            with patch.object(browse_routes, "auth_enabled", lambda: True), \
                    patch.object(browse_routes.auth_manager, "verify_password", lambda user, p: p == "right"):
                self.assertEqual((await client.post("/api/browse/passwords/unlock", json={"password": "wrong"})).status_code, 403)
                self.assertEqual((await client.post(f"/api/browse/passwords/{login_id}/reveal")).status_code, 403)
                ok = await client.post("/api/browse/passwords/unlock", json={"password": "right"})
                self.assertEqual(ok.status_code, 200)
                revealed = await client.post(f"/api/browse/passwords/{login_id}/reveal")
                self.assertEqual(revealed.json(), {"password": "hunter2-xyz"})
                for _ in range(5):
                    await client.post("/api/browse/passwords/unlock", json={"password": "wrong"})
                self.assertEqual((await client.post("/api/browse/passwords/unlock", json={"password": "right"})).status_code, 429)
            edited = await client.patch(f"/api/browse/passwords/{login_id}", json={"username": "me2"})
            self.assertEqual(edited.json()["username"], "me2")
            self.assertEqual((await client.delete(f"/api/browse/passwords/{login_id}")).json(), {"deleted": True})
            self.assertEqual((await client.delete(f"/api/browse/passwords/{login_id}")).status_code, 404)
            generated = (await client.get("/api/browse/passwords/generate")).json()["password"]
            self.assertEqual(len(generated), pw.GENERATED_LENGTH)
            imported = await client.post("/api/browse/passwords/import", json={"csv": "url,username,password\nhttps://c.test,u,p\n"})
            self.assertEqual(imported.json()["added"], 1)

    async def test_unknown_fields_are_refused(self):
        async with self.client() as client:
            response = await client.post("/api/browse/passwords", json={"url": "https://a.test", "password": "x", "origin": "https://b.test"})
        self.assertEqual(response.status_code, 422)


class CookieOnlyTests(unittest.TestCase):
    def test_a_terminal_token_cannot_reach_the_password_routes(self):
        for path in ("/api/browse/passwords", "/api/browse/passwords/desktop/fill", "/api/browse/profile"):
            self.assertFalse(cli_access.token_route_allowed(path), path)


if __name__ == "__main__":
    unittest.main()
