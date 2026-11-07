"""Browse's password keeper (services/browse_passwords.py, routes/browse_routes.py /passwords).

- Saved per account, in the account's secrets folder, encrypted with the account's own key: nothing readable
  on disk, and another account's key can't open it.
- A password leaves only for its exact origin (fill), or after the person re-entered their password (reveal).
- The desktop routes (match, fill, save) need the desktop app's secret as well as the sign-in.
- Chrome-style CSV import, the never-save list, the strong-password generator.
- The routes stay cookie-only (no paired terminal).
- Bots (David, 2026-11-07: "yes bots can use your saved passwords, but that can be turned off"): the switch is
  on by default and off gives bots nothing; exact site only, never a field in another site's frame; one
  account's bots never reach another account's store; every use is recorded and listed; the value reaches the
  driver only, never a model's text, a log or the use list; bots have no way to read, change or save.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import time
import urllib.parse
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
environment = tempfile.TemporaryDirectory(prefix="kairos-browse-pw-", ignore_cleanup_errors=True)
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


class RouteBase(unittest.IsolatedAsyncioTestCase):
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


class RouteTests(RouteBase):
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


BOT_A, BOT_B = "0123456789", "abcdef0123"  # Scout is Alice's bot, Rex is Bob's
BOTS = {ALICE: {BOT_A: "Scout"}, BOB: {BOT_B: "Rex"}}
SECRET_PW = "Tr0ub4dor-and-3"
SITE = "https://x.com"


def bot_name(bot_id):
    return BOTS.get(accounts.current_account(), {}).get(bot_id)


class BotStoreTests(unittest.TestCase):
    def setUp(self):
        for account_id in (ALICE, BOB):
            shutil.rmtree(accounts.account_dir(account_id), ignore_errors=True)
        names = patch.object(pw, "_bot_name", bot_name)
        names.start()
        self.addCleanup(names.stop)
        with accounts.as_account(ALICE):
            self.login_id = pw.save(f"{SITE}/i/flow/login", "al", SECRET_PW)["id"]

    def test_on_by_default_and_off_gives_bots_nothing(self):
        with accounts.as_account(ALICE):
            self.assertTrue(pw.bots_allowed(), "on by default")
            line = pw.bot_prompt_line()
            self.assertIn('login_id "browse"', line)
            for private in (SECRET_PW, "al ", "x.com"):
                self.assertNotIn(private, line, "the prompt names no site, username or password")
            self.assertEqual(pw.bot_fill(None, BOT_A, f"{SITE}/login")["password"], SECRET_PW)
            self.assertFalse(pw.set_bots_allowed(False))
            self.assertFalse(pw.bots_allowed())
            self.assertIsNone(pw.bot_prompt_line(), "off: bots are told nothing")
            with self.assertRaises(pw.PasswordError) as off:
                pw.bot_fill(None, BOT_A, f"{SITE}/login")
            self.assertEqual(off.exception.status, 403)
            with self.assertRaises(pw.PasswordError):
                pw.bot_fill(self.login_id, BOT_A, f"{SITE}/login")
            self.assertEqual(len(pw.bot_uses()), 1, "a refused fill is not a use")
            self.assertEqual(pw.fill(self.login_id, f"{SITE}/"), {"username": "al", "password": SECRET_PW},
                             "the person's own fill is unchanged")
            pw.set_bots_allowed(True)
            self.assertEqual(pw.bot_fill(self.login_id, BOT_A, f"{SITE}/")["username"], "al")
        with accounts.as_account(BOB):
            self.assertTrue(pw.bots_allowed(), "a new account starts on as well")
            self.assertIsNone(pw.bot_prompt_line(), "nothing saved: nothing to say")

    def test_exact_site_only_and_never_a_frame_of_another_site(self):
        with accounts.as_account(ALICE):
            for other in ("https://mobile.x.com/", "http://x.com/", "https://x.com:8443/", "https://x.com.evil.test/",
                          "https://evil.test/?u=https://x.com", "about:blank", "javascript:alert(1)"):
                with self.assertRaises(pw.PasswordError, msg=other):
                    pw.bot_fill(None, BOT_A, other)
                with self.assertRaises(pw.PasswordError, msg=other):
                    pw.bot_fill(self.login_id, BOT_A, other)
            for frames in ([f"{SITE}/", "https://idp.test/login"], ["https://x.com.evil.test/"], [""], ["about:srcdoc"]):
                with self.assertRaises(pw.PasswordError, msg=frames) as caught:
                    pw.bot_fill(None, BOT_A, f"{SITE}/login", frames)
                self.assertEqual(caught.exception.status, 403)
            self.assertEqual(pw.bot_fill(None, BOT_A, f"{SITE}/login", [f"{SITE}/login", f"{SITE}/frame"])["username"], "al")
            second = pw.save(SITE, "al2", "an-other-pw-9")["id"]
            with self.assertRaises(pw.PasswordError) as several:
                pw.bot_fill(None, BOT_A, f"{SITE}/login")
            self.assertEqual(several.exception.status, 409)
            self.assertIn(f"browse:{second}", str(several.exception))
            self.assertNotIn(SECRET_PW, str(several.exception))
            self.assertNotIn("an-other-pw-9", str(several.exception))
            self.assertEqual(pw.bot_fill(second, BOT_A, f"{SITE}/login")["password"], "an-other-pw-9")
            other_site = pw.save("https://bank.test", "al", "bank-pw-123")["id"]
            with self.assertRaises(pw.PasswordError):
                pw.bot_fill(other_site, BOT_A, f"{SITE}/login")  # a login id never widens the site
            self.assertEqual([u["origin"] for u in pw.bot_uses()], [SITE, SITE])

    def test_one_accounts_bots_never_reach_another_accounts_store(self):
        with accounts.as_account(BOB):
            self.assertIsNone(pw.bot_prompt_line())
            for choice in (None, self.login_id):
                with self.assertRaises(pw.PasswordError):
                    pw.bot_fill(choice, BOT_B, f"{SITE}/login")
            with self.assertRaises(pw.PasswordError) as foreign:
                pw.bot_fill(None, BOT_A, f"{SITE}/login")  # Alice's bot is no bot of Bob's account
            self.assertIn("available to this bot", str(foreign.exception))
            pw.save(SITE, "bob", "bobs-own-pw-1")
            self.assertEqual(pw.bot_fill(None, BOT_B, f"{SITE}/login")["password"], "bobs-own-pw-1")
        with accounts.as_account(ALICE):
            with self.assertRaises(pw.PasswordError):
                pw.bot_fill(None, BOT_B, f"{SITE}/login")  # and Bob's bot is no bot of Alice's
            self.assertEqual(pw.bot_uses(), [], "no use was recorded in Alice's store")
            self.assertEqual(pw.bot_fill(None, BOT_A, f"{SITE}/login")["password"], SECRET_PW)
        with accounts.as_account(BOB):
            self.assertEqual([u["bot"] for u in pw.bot_uses()], ["Rex"])
        for bad in ("", "../../x", "0123456789a", None, "ABCDEFGHI!"):
            with accounts.as_account(ALICE), self.assertRaises(pw.PasswordError):
                pw.bot_fill(None, bad, f"{SITE}/login")

    def test_each_use_is_recorded_listed_and_carries_no_password(self):
        with accounts.as_account(ALICE):
            pw.bot_fill(None, BOT_A, f"{SITE}/login")
            uses = pw.bot_uses()
            self.assertEqual(len(uses), 1)
            self.assertEqual({k: uses[0][k] for k in ("bot_id", "bot", "origin", "username")},
                             {"bot_id": BOT_A, "bot": "Scout", "origin": SITE, "username": "al"})
            self.assertLess(abs(uses[0]["at"] - time.time()), 60)
            self.assertNotIn(SECRET_PW, json.dumps(uses))
            row = pw.list_logins()[0]
            self.assertEqual(row["last_bot_use"], uses[0]["at"])
            self.assertNotIn(SECRET_PW, json.dumps(row))
            with patch.object(pw, "MAX_BOT_USES", 3):
                for _ in range(5):
                    pw.bot_fill(None, BOT_A, f"{SITE}/login")
                self.assertEqual(len(pw.bot_uses()), 3, "the list keeps the newest")
        with open(file_of(ALICE), "rb") as f:
            raw = f.read()
        for plain in (SECRET_PW.encode(), b"Scout", b"x.com"):
            self.assertNotIn(plain, raw, "the use list is encrypted with the rest")

    def test_a_filled_password_is_scrubbed_even_after_a_restart(self):
        from core.bot_held_secrets import held
        with accounts.as_account(ALICE):
            held.clear()
            held.add_source(pw._bot_used_passwords)
            self.assertEqual(held.scrub(f"page says {SECRET_PW}"), f"page says {SECRET_PW}", "never used by a bot: not touched")
            pw.bot_fill(None, BOT_A, f"{SITE}/login")
            held.clear()
            held.add_source(pw._bot_used_passwords)  # what importing the module does after a restart
            for echo in (SECRET_PW, json.dumps(SECRET_PW), urllib.parse.quote(SECRET_PW, safe="")):
                self.assertNotIn(SECRET_PW, held.scrub(f"page says {echo}"))
        with accounts.as_account(BOB):
            self.assertEqual(list(pw._bot_used_passwords()), [], "Bob's store has none")


class FakeDriver:
    """The contained computer's driver: answers state, login_fields and fill_login, and echoes the password in a read."""

    def __init__(self, url, fields, frames=None):
        self.stdin, self.stdout, self.stderr = self, asyncio.StreamReader(), asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode, self.calls, self.buffer = None, [], b""
        self.url, self.fields, self.frames = url, fields, frames or [url]

    def write(self, data):
        self.buffer += data

    async def drain(self):
        for line in self.buffer.splitlines():
            command = json.loads(line)
            self.calls.append(command)
            action, out = command["action"], {"id": command["id"]}
            if action == "login_fields":
                out.update(url=self.url, frames=self.frames, fields=self.fields, opaque=False)
            elif action == "fill_login":
                out.update(url=self.url, filled=[k for k in ("username", "password", "code") if command["values"].get(k)])
            elif action == "read":
                out.update(url=self.url, title="Sign in", text=f"Your password is {SECRET_PW}",
                           elements=[{"ref": "1", "label": "Password", "value": SECRET_PW}])
            else:
                out.update(url=self.url, title="Sign in")
            self.stdout.feed_data((json.dumps(out) + "\n").encode())
        self.buffer = b""

    def close(self):
        self.returncode = 0

    async def wait(self):
        return 0

    def kill(self):
        self.returncode = -9


FIELDS = [{"kind": "username", "frame": 0, "index": 0, "label": "Email"}, {"kind": "password", "frame": 0, "index": 1, "label": "Password"}]


class BotFillTests(unittest.IsolatedAsyncioTestCase):
    """core/computer.py fill_login with login_id "browse": the harness fills, the model sees no value."""

    async def asyncSetUp(self):
        from core import computer
        from core.bot_held_secrets import held
        for account_id in (ALICE, BOB):
            shutil.rmtree(accounts.account_dir(account_id), ignore_errors=True)
        held.clear()
        held.add_source(pw._bot_used_passwords)
        self.names = patch.object(pw, "_bot_name", bot_name)
        self.names.start()
        self.computer = computer
        self.token = accounts.set_current(ALICE)
        pw.save(SITE, "al", SECRET_PW)
        self.ctx = SimpleNamespace(permission_surface="chat:test", is_admin=True, turn_taint=None)

    async def asyncTearDown(self):
        accounts.reset_current(self.token)
        self.names.stop()

    async def started(self, driver):
        manager = self.computer.ComputerManager(process_factory=None)
        c = self.computer.Computer("chat:test", driver, "test-computer", last_action=0, hosts={"x.com", "idp.test"})
        c.reader_task = asyncio.create_task(manager._read(c))
        manager._computers["chat:test"] = c

        async def finish():
            manager._computers.pop("chat:test", None)
            driver.stdout.feed_eof()
            await asyncio.sleep(0)
            c.reader_task.cancel()
        self.addAsyncCleanup(finish)
        return manager

    def fills(self, driver):
        return [c for c in driver.calls if c["action"] == "fill_login"]

    async def test_the_value_reaches_the_driver_only(self):
        driver = FakeDriver(f"{SITE}/i/flow/login", FIELDS)
        manager = await self.started(driver)
        captured = []
        handler = logging.Handler(logging.DEBUG)
        handler.emit = lambda record: captured.append(record.getMessage())
        root = logging.getLogger()
        root.addHandler(handler)
        level = root.level
        root.setLevel(logging.DEBUG)
        try:
            result = await manager.fill_login("chat:test", BOT_A, "browse", self.ctx)
            shown = await manager.act("chat:test", "read", {}, self.ctx)
        finally:
            root.removeHandler(handler)
            root.setLevel(level)
        self.assertIn(f"Filled username, password for the Browse password saved for {SITE}", result["text"])
        self.assertIn("Nothing was submitted", result["text"])
        self.assertEqual(self.fills(driver)[0]["values"], {"username": "al", "password": SECRET_PW, "code": None})
        self.assertEqual(self.fills(driver)[0]["expected_url"], f"{SITE}/i/flow/login")
        self.assertEqual(self.fills(driver)[0]["only_frames"], [0], "the driver may type into frames of the exact site only")
        for what, value in (("the tool result", result), ("a read of the page", shown), ("a log line", captured)):
            self.assertNotIn(SECRET_PW, json.dumps(value, default=str), what)
        self.assertIn("[saved password]", json.dumps(shown, default=str), "the page's echo is masked")
        self.assertEqual([(u["bot"], u["origin"]) for u in pw.bot_uses()], [("Scout", SITE)])

    async def test_off_another_site_a_foreign_frame_and_another_account_fill_nothing(self):
        cases = [
            ("off", f"{SITE}/login", FIELDS, None, lambda: pw.set_bots_allowed(False), "turned off"),
            ("another site", "https://idp.test/login", FIELDS, None, None, "No Browse password"),
            ("a frame of another site", f"{SITE}/login", [{**f, "frame": 1} for f in FIELDS],
             [f"{SITE}/login", "https://idp.test/frame"], None, "frame from another site"),
            ("a frame the scan never listed", f"{SITE}/login", [{**f, "frame": 7} for f in FIELDS], None, None,
             "frame from another site"),
            ("another account", f"{SITE}/login", FIELDS, None, lambda: accounts.set_current(BOB), "available to this bot"),
        ]
        for name, url, fields, frames, before, expect in cases:
            pw.set_bots_allowed(True)
            driver = FakeDriver(url, fields, frames)
            manager = await self.started(driver)
            if before:
                before()
            result = await manager.fill_login("chat:test", BOT_A, "browse", self.ctx)
            accounts.set_current(ALICE)
            self.assertTrue(result["text"].startswith("Not filled:"), (name, result["text"]))
            self.assertIn(expect, result["text"], name)
            self.assertEqual(self.fills(driver), [], name)
            self.assertNotIn(SECRET_PW, json.dumps(result), name)
        self.assertEqual(pw.bot_uses(), [], "nothing filled, nothing recorded")

    async def test_a_frame_of_another_site_without_fields_is_left_out_of_the_fill(self):
        # The fields are in the page itself; another site's frame has none at the scan. If it gains a field before
        # the driver types, the driver still skips it (only_frames).
        driver = FakeDriver(f"{SITE}/login", FIELDS, [f"{SITE}/login", "https://idp.test/widget", f"{SITE}/inner"])
        manager = await self.started(driver)
        result = await manager.fill_login("chat:test", BOT_A, "browse", self.ctx)
        self.assertIn("Filled username, password", result["text"])
        self.assertEqual(self.fills(driver)[0]["only_frames"], [0, 2])

    def test_the_driver_filters_fields_to_those_frames_before_choosing(self):
        from core.computer_driver import SOURCE
        block = SOURCE[SOURCE.index("async def login_command"):SOURCE.index("async def execute")]
        self.assertLess(block.index("cmd['only_frames']"), block.index("chosen = {}"))


class BotsCannotTouchTheStore(unittest.TestCase):
    def test_only_the_harness_fill_and_the_prompt_reach_the_store_outside_the_keepers_own_routes(self):
        allowed = {"bot_fill", "bot_choice", "bot_prompt_line", "PasswordError", "origin_of"}
        for folder in ("core", "services", "mcp_servers"):
            for path in (ROOT / folder).rglob("*.py"):
                if path.name == "browse_passwords.py":
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                if "browse_passwords" not in text:
                    continue
                used = set(re.findall(r"browse_passwords\.(\w+)", text))
                self.assertLessEqual(used, allowed, f"{path.relative_to(ROOT)} uses {sorted(used - allowed)}")

    def test_no_bot_tool_reaches_the_store(self):
        text = (ROOT / "core" / "tool_registry.py").read_text(encoding="utf-8")
        self.assertNotIn("browse_passwords", text, "no tool lists, reads, reveals, exports, edits, deletes or saves")


class BotRouteTests(RouteBase):
    async def test_the_switch_and_the_use_list(self):
        async with self.client() as client:
            listing = (await client.get("/api/browse/passwords")).json()
            self.assertIs(listing["bots_may_use"], True)
            self.assertEqual(listing["bot_uses"], [])
            off = await client.post("/api/browse/passwords/bots", json={"allowed": False})
            self.assertEqual(off.json(), {"bots_may_use": False})
            self.assertIs((await client.get("/api/browse/passwords")).json()["bots_may_use"], False)
            tool = await client.post("/api/browse/passwords/bots", json={"allowed": True}, headers={"X-JARVIS-Tool-Token": "t"})
            self.assertEqual(tool.status_code, 403, "a model's tool access can't turn it back on")
            self.assertIs((await client.get("/api/browse/passwords")).json()["bots_may_use"], False)
            self.assertEqual((await client.post("/api/browse/passwords/bots", json={"allowed": "yes please"})).status_code, 422)
            await client.post("/api/browse/passwords/bots", json={"allowed": True})
            await client.post("/api/browse/passwords", json={"url": SITE, "username": "al", "password": SECRET_PW})
        with patch.object(pw, "_bot_name", lambda bot_id: "Scout"):
            pw.bot_fill(None, BOT_A, f"{SITE}/login")
        async with self.client() as client:
            listed = await client.get("/api/browse/passwords")
        self.assertEqual([(u["bot"], u["origin"], u["username"]) for u in listed.json()["bot_uses"]], [("Scout", SITE, "al")])
        self.assertNotIn(SECRET_PW, listed.text)

    async def test_without_the_persons_sign_in_every_password_route_refuses(self):
        self.app.dependency_overrides.clear()
        with patch.object(middleware, "get_current_user", lambda request: None):
            async with self.client() as client:
                for method, path, body in (("GET", "/api/browse/passwords", None), ("POST", "/api/browse/passwords/bots", {"allowed": True}),
                                           ("POST", "/api/browse/passwords", {"url": SITE, "password": "x"}),
                                           ("POST", "/api/browse/passwords/import", {"csv": "url,password\nhttps://a.test,x\n"}),
                                           ("POST", "/api/browse/passwords/abc/reveal", None), ("DELETE", "/api/browse/passwords/abc", None),
                                           ("PATCH", "/api/browse/passwords/abc", {"username": "x"})):
                    kwargs = {"headers": {"X-JARVIS-Tool-Token": "a-turn-token"}, **({"json": body} if body is not None else {})}
                    response = await client.request(method, path, **kwargs)
                    self.assertEqual(response.status_code, 401, (method, path))


class CookieOnlyTests(unittest.TestCase):
    def test_a_terminal_token_cannot_reach_the_password_routes(self):
        for path in ("/api/browse/passwords", "/api/browse/passwords/desktop/fill", "/api/browse/profile"):
            self.assertFalse(cli_access.token_route_allowed(path), path)


if __name__ == "__main__":
    unittest.main()
