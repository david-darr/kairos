"""The Kairos iPhone app's side of the desktop (specs/phone-api.md): pairing with a six-digit code, signing in
with the device token on ordinary routes, on the live stream and on a websocket, isolation between two
accounts, unpairing, what a phone token may never do, Home at a glance, a ring's state, and native push
through a local stand-in for the push relay that checks every signature the way the real relay does.

Runs the real app against a throwaway data folder. Nothing here reaches a running Kairos, Apple or the internet.

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_phone_api.py
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix="kairos-phone-api-", dir=tempfile.gettempdir())  # the app holds its databases open at exit
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as kairos  # noqa: E402
from core import accounts, middleware, mobile_activity, phone_devices, phone_push  # noqa: E402
from core import settings as settings_store  # noqa: E402
from core.auth import SESSION_COOKIE_NAME, auth_manager  # noqa: E402
from routes import auth_routes  # noqa: E402
from services import mobile_notifications, rings  # noqa: E402

PASSWORDS = {"ana": "ana-password-1", "ben": "ben-password-2"}
WRONG = {"detail": "That code is not right or has expired."}
TOO_MANY = {"detail": "Too many tries. Make a new code on your desktop."}
APNS, APNS2, VOIP = "a1" * 32, "b2" * 32, "c3" * 32
ACTIVITY_TOKEN = "d4" * 40


def browser(name=None, address=("testclient", 50000)) -> TestClient:
    client = TestClient(kairos.app, client=address)
    if name:
        r = client.post("/api/auth/login", json={"username": name, "password": PASSWORDS[name]})
        assert r.status_code == 200, r.text
    return client


def phone(token, address=("testclient", 50000)) -> TestClient:
    return TestClient(kairos.app, headers={"Authorization": f"Bearer {token}"}, client=address)


def pair(name, **device):
    """Pair a phone for an account the way a person does: a code from the signed-in app, claimed with no sign-in."""
    started = BROWSERS[name].post("/api/phone/pair/start")
    assert started.status_code == 200, started.text
    body = {"code": started.json()["code"], "device_name": "iPhone", "device_model": "iPhone17,1", "app_version": "0.1.0", **device}
    claimed = TestClient(kairos.app).post("/api/phone/pair/claim", json=body)
    assert claimed.status_code == 200, claimed.text
    return claimed.json()["token"], claimed.json()["device_id"]


def reset_limits():
    phone_devices._codes.clear()
    phone_devices._claim_tries.clear()
    auth_routes._login_by_address.clear()
    auth_routes._login_by_username.clear()


BROWSERS = {}


def setUpModule():
    auth_manager._users = {"users": {}}
    auth_manager._sessions = {}
    setup = TestClient(kairos.app)
    assert setup.post("/api/auth/setup", json={"username": "ana", "password": PASSWORDS["ana"]}).status_code == 200
    assert setup.post("/api/auth/users", json={"username": "ben", "password": PASSWORDS["ben"]}).status_code == 200
    BROWSERS["ana"], BROWSERS["ben"] = browser("ana"), browser("ben")


def tearDownModule():
    # Let the throwaway folder go on Windows: the stores and log files the app holds open.
    from services.content_studio import close_all
    close_all()
    from core import bot_rooms_store
    bot_rooms_store.close()
    for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
        for handler in list(getattr(logger, "handlers", [])):
            if isinstance(handler, logging.FileHandler):
                handler.close()
                logger.removeHandler(handler)


class Base(unittest.TestCase):
    def setUp(self):
        reset_limits()
        self.addCleanup(reset_limits)


# -- pairing --------------------------------------------------------------------------------------------------

class Pairing(Base):
    def start(self, name="ana"):
        r = BROWSERS[name].post("/api/phone/pair/start")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def claim(self, code, address=("testclient", 50000), **extra):
        return TestClient(kairos.app, client=address).post("/api/phone/pair/claim", json={"code": code, **extra})

    def test_a_code_is_six_digits_for_ten_minutes_and_only_a_signed_in_browser_makes_one(self):
        self.assertEqual(TestClient(kairos.app).post("/api/phone/pair/start").status_code, 401)
        started = self.start()
        self.assertRegex(started["code"], r"^[0-9]{6}$")
        self.assertRegex(started["expires_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        left = time.mktime(time.strptime(started["expires_at"], "%Y-%m-%dT%H:%M:%SZ")) - time.mktime(time.gmtime())
        self.assertTrue(590 <= left <= 601, left)
        self.assertIsNone(started["address"], "remote access is off in this test")
        with patch("core.remote_access.current_url", return_value="https://example-host:8422"):
            self.assertEqual(self.start()["address"], "https://example-host:8422")

    def test_a_request_from_another_site_cannot_make_a_code(self):
        r = BROWSERS["ana"].post("/api/phone/pair/start", headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        r = BROWSERS["ana"].post("/api/phone/pair/start", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(r.status_code, 403)
        self.assertFalse(phone_devices.pairing_waiting("ana"))

    def test_claiming_answers_the_token_once_and_only_its_hash_is_kept(self):
        code = self.start()["code"]
        r = self.claim(code, device_name="Ana's\x00 iPhone\n", device_model="iPhone17,1", app_version="0.1.0")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertRegex(body["token"], r"^kph_[A-Za-z0-9_-]{43}$")
        self.assertRegex(body["device_id"], r"^d_[0-9a-f]{24}$")
        self.assertEqual(body["account"], {"username": "ana", "is_admin": True, "color": auth_manager.account_color("ana")})
        self.assertEqual(body["server"]["name"], "Kairos")
        self.assertRegex(body["server"]["version"], r"^\d+\.\d+\.\d+")
        self.assertEqual(r.headers["cache-control"], "no-store")
        stored = Path(phone_devices.DEVICES_FILE).read_text(encoding="utf-8")
        self.assertNotIn(body["token"], stored)
        self.assertNotIn(body["token"][4:], stored)
        self.assertIn(hashlib.sha256(body["token"].encode()).hexdigest(), stored)
        listed = phone(body["token"]).get("/api/phone/devices").json()["devices"]
        mine = next(d for d in listed if d["id"] == body["device_id"])
        self.assertEqual((mine["name"], mine["model"], mine["current"]), ("Ana's iPhone", "iPhone17,1", True), "the name is cleaned")
        self.assertNotIn("token", json.dumps(listed))

    def test_a_code_works_once(self):
        code = self.start()["code"]
        self.assertEqual(self.claim(f" {code[:3]} {code[3:]} ").status_code, 200, "typed with the space the settings page shows")
        again = self.claim(code)
        self.assertEqual((again.status_code, again.json()), (400, WRONG))

    def test_a_new_code_cancels_the_old_one(self):
        old = self.start()["code"]
        new = self.start()["code"]
        if old != new:
            self.assertEqual(self.claim(old, address=("10.1.1.1", 1)).json(), WRONG)
        self.assertEqual(self.claim(new, address=("10.1.1.2", 1)).status_code, 200)

    def test_a_code_expires_after_ten_minutes(self):
        code, expires_at = phone_devices.start_pairing("ana", now=1000.0)
        self.assertEqual(expires_at, 1600.0)
        with self.assertRaises(phone_devices.PairError) as late:
            phone_devices.claim(code, "10.0.0.1", now=1600.5)
        self.assertEqual((late.exception.status, late.exception.detail), (400, WRONG["detail"]))
        code = self.start()["code"]
        phone_devices._codes["ana"]["expires_at"] = time.time() - 1
        r = self.claim(code)
        self.assertEqual((r.status_code, r.json()), (400, WRONG))

    def test_five_wrong_tries_from_one_address_lock_it_out_and_cancel_the_code(self):
        code = self.start()["code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(4):
            r = self.claim(wrong)
            self.assertEqual((r.status_code, r.json()), (400, WRONG))
        fifth = self.claim(wrong)
        self.assertEqual((fifth.status_code, fifth.json()), (429, TOO_MANY))
        self.assertGreater(int(fifth.headers["retry-after"]), 0)
        self.assertFalse(phone_devices.pairing_waiting("ana"), "the code is cancelled")
        right_but_late = self.claim(code)
        self.assertEqual((right_but_late.status_code, right_but_late.json()), (429, TOO_MANY), "even the right code is refused now")
        fresh = self.start()["code"]
        self.assertEqual(self.claim(fresh).status_code, 429, "a new code does not unlock a locked address")
        self.assertEqual(self.claim(fresh, address=("10.9.9.9", 1)).status_code, 200, "another address is not locked")

    def test_a_locked_address_is_let_back_in_when_its_ten_minutes_pass_and_its_tries_do_not_count(self):
        for n in range(5):
            with self.assertRaises(phone_devices.PairError):
                phone_devices.claim("999999", "10.2.2.2", now=1000.0 + n)
        code, _ = phone_devices.start_pairing("ana", now=1010.0)
        for n in range(20):  # locked out: these are not looked at, so they cannot wear the new code down
            with self.assertRaises(phone_devices.PairError) as locked:
                phone_devices.claim("999998", "10.2.2.2", now=1011.0 + n)
            self.assertEqual(locked.exception.status, 429)
        self.assertTrue(phone_devices.pairing_waiting("ana", now=1040.0))
        with self.assertRaises(phone_devices.PairError) as still:
            phone_devices.claim(code, "10.2.2.2", now=1500.0)  # the right code, but still inside the ten minutes
        self.assertEqual(still.exception.status, 429)
        self.assertGreater(still.exception.retry_after, 0)
        made = phone_devices.claim(code, "10.2.2.2", now=1601.0)  # the first wrong try has aged out
        self.assertEqual(made["device"]["username"], "ana")
        phone_devices.revoke("ana", made["device"]["id"])

    def test_five_wrong_tries_against_one_code_cancel_it_whatever_addresses_they_come_from(self):
        code = self.start()["code"]
        wrong = "000000" if code != "000000" else "111111"
        answers = [self.claim(wrong, address=(f"10.3.3.{n}", 1)) for n in range(1, 6)]
        self.assertEqual([a.status_code for a in answers], [400, 400, 400, 400, 429])
        self.assertEqual(answers[-1].json(), TOO_MANY)
        late = self.claim(code, address=("10.3.3.99", 1))
        self.assertEqual((late.status_code, late.json()), (400, WRONG), "the code is gone for everyone")

    def test_a_code_of_the_wrong_shape_is_a_wrong_try_not_a_free_one(self):
        self.start()
        for bad in ("", "12345", "1234567", "abcdef", "１２３４５６", "12-34-56"):
            reset_limits()
            self.start()
            r = self.claim(bad)
            self.assertEqual((r.status_code, r.json()), (400, WRONG), bad)
            self.assertEqual(phone_devices._codes["ana"]["wrong"], 1, bad)
        self.assertEqual(self.claim("1" * 65).status_code, 422, "an absurd length is refused before anything else")

    def test_an_ipv6_caller_cannot_get_fresh_tries_by_changing_its_address(self):
        for n in range(5):
            with self.assertRaises(phone_devices.PairError):
                phone_devices.claim("999999", f"2001:db8:1:2::{n + 1}", now=1000.0 + n)
        with self.assertRaises(phone_devices.PairError) as locked:
            phone_devices.claim("999999", "2001:db8:1:2:ffff::9", now=1010.0)
        self.assertEqual(locked.exception.status, 429)
        with self.assertRaises(phone_devices.PairError) as other:
            phone_devices.claim("999999", "2001:db8:1:3::1", now=1010.0)
        self.assertEqual(other.exception.status, 400, "another /64 is another caller")

    def test_two_accounts_codes_never_cross(self):
        a, b = self.start("ana")["code"], self.start("ben")["code"]
        self.assertNotEqual(a, b)
        got_b = self.claim(b, address=("10.4.4.1", 1)).json()
        got_a = self.claim(a, address=("10.4.4.2", 1)).json()
        self.assertEqual((got_a["account"]["username"], got_b["account"]["username"]), ("ana", "ben"))
        self.assertEqual((got_a["account"]["is_admin"], got_b["account"]["is_admin"]), (True, False))

    def test_an_account_holds_at_most_ten_phones(self):
        made = [pair("ben")[1] for _ in range(phone_devices.MAX_DEVICES_PER_ACCOUNT - len(phone_devices.devices_for("ben")))]
        r = BROWSERS["ben"].post("/api/phone/pair/start")
        self.assertEqual(r.status_code, 409, r.text)
        for device_id in made:
            self.assertTrue(phone_devices.revoke("ben", device_id))


# -- signing in with the token ------------------------------------------------------------------------------------

class TokenSignIn(Base):
    @classmethod
    def setUpClass(cls):
        reset_limits()
        cls.ana_token, cls.ana_device = pair("ana")
        cls.ben_token, cls.ben_device = pair("ben")
        cls.ana, cls.ben = phone(cls.ana_token), phone(cls.ben_token)
        for name in ("ana", "ben"):
            r = BROWSERS[name].post("/api/notes", json={"text": f"NOTE-OF-{name.upper()}"})
            assert r.status_code < 300, r.text

    def test_the_token_is_that_account_on_an_ordinary_route(self):
        for client, name, other in ((self.ana, "ana", "ben"), (self.ben, "ben", "ana")):
            notes = client.get("/api/notes")
            self.assertEqual(notes.status_code, 200, notes.text)
            self.assertIn(f"NOTE-OF-{name.upper()}", notes.text)
            self.assertNotIn(f"NOTE-OF-{other.upper()}", notes.text)
            self.assertEqual(client.get("/api/auth/status").json()["username"], name)
        made = self.ben.post("/api/notes", json={"text": "WRITTEN-FROM-BENS-PHONE"})
        self.assertLess(made.status_code, 300, made.text)
        self.assertIn("WRITTEN-FROM-BENS-PHONE", BROWSERS["ben"].get("/api/notes").text, "the same account as his browser")
        self.assertNotIn("WRITTEN-FROM-BENS-PHONE", BROWSERS["ana"].get("/api/notes").text)

    def test_session_says_who_and_which_phone(self):
        r = self.ana.get("/api/phone/session")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["account"], {"username": "ana", "is_admin": True, "color": auth_manager.account_color("ana")})
        self.assertEqual(r.json()["device_id"], self.ana_device)
        self.assertEqual(r.json()["server"]["name"], "Kairos")
        self.assertEqual(self.ben.get("/api/phone/session").json()["account"]["is_admin"], False)
        self.assertIsNone(BROWSERS["ana"].get("/api/phone/session").json()["device_id"], "a browser is not a phone")

    def test_an_unknown_or_malformed_token_is_401_everywhere(self):
        unknown = "kph_" + "A" * 43
        for token in (unknown, "kph_short", self.ana_token[:-1], self.ana_token + "x", "kph_" + "!" * 43):
            for path in ("/api/notes", "/api/phone/session", "/api/health", "/api/auth/status", "/api/phone/devices"):
                r = TestClient(kairos.app, headers={"Authorization": f"Bearer {token}"}).get(path)
                self.assertEqual((r.status_code, r.json()), (401, {"detail": "authentication required"}), (token[:10], path))
        self.assertEqual(TestClient(kairos.app, headers={"Authorization": "Bearer something-else"}).get("/api/health").status_code, 200,
                         "another kind of bearer is not ours to judge")

    def test_a_token_is_only_read_from_the_authorization_header(self):
        for client_kwargs, path in (({}, f"/api/notes?token={self.ana_token}"), ({}, f"/api/notes?access_token={self.ana_token}"),
                                    ({"cookies": {SESSION_COOKIE_NAME: self.ana_token}}, "/api/notes"),
                                    ({"headers": {"X-Authorization": f"Bearer {self.ana_token}"}}, "/api/notes"),
                                    ({"headers": {"Authorization": f"Basic {self.ana_token}"}}, "/api/notes")):
            r = TestClient(kairos.app, **client_kwargs).get(path)
            self.assertEqual(r.status_code, 401, (client_kwargs, path))

    def test_a_token_is_judged_alone_never_by_a_cookie_beside_it(self):
        bens_cookie = BROWSERS["ben"].cookies.get(SESSION_COOKIE_NAME)
        both = TestClient(kairos.app, headers={"Authorization": f"Bearer {self.ana_token}"}, cookies={SESSION_COOKIE_NAME: bens_cookie})
        self.assertEqual(both.get("/api/auth/status").json()["username"], "ana")
        self.assertNotIn("NOTE-OF-BEN", both.get("/api/notes").text)
        dead = TestClient(kairos.app, headers={"Authorization": "Bearer kph_" + "B" * 43}, cookies={SESSION_COOKIE_NAME: bens_cookie})
        self.assertEqual(dead.get("/api/notes").status_code, 401, "a dead token does not fall back to the cookie")

    def test_a_non_admins_token_is_never_an_admin(self):
        self.assertEqual(self.ben.get("/api/settings/agent-tools").status_code, 403)
        self.assertEqual(self.ben.post("/api/settings/computer-use", json={"enabled": True}).status_code, 403)
        self.assertEqual(self.ben.get("/api/phone/push/relay").status_code, 403)
        self.assertEqual(self.ben.get("/api/auth/status").json()["is_admin"], False)
        self.assertEqual(self.ana.get("/api/settings/agent-tools").status_code, 200, "an admin's phone is an admin, like her browser")

    def test_admin_is_read_from_the_account_each_time_not_from_the_token(self):
        auth_manager._users["users"]["ben"]["is_admin"] = True
        try:
            self.assertEqual(self.ben.get("/api/settings/agent-tools").status_code, 200)
        finally:
            auth_manager._users["users"]["ben"]["is_admin"] = False
        self.assertEqual(self.ben.get("/api/settings/agent-tools").status_code, 403, "taken away the moment the account loses it")

    def test_what_stays_with_the_desktop(self):
        refusals = [("POST", "/api/phone/pair/start", None), ("GET", "/api/phone/push/relay", None),
                    ("PUT", "/api/phone/push/relay", {"url": "https://relay.example"}),
                    ("POST", "/api/auth/password", {"current_password": PASSWORDS["ana"], "new_password": "another-password-9"}),
                    ("POST", "/api/auth/totp/enroll", None), ("POST", "/api/auth/totp/disable", None),
                    ("PUT", "/api/auth/account/switch-pin", {"password": PASSWORDS["ana"], "pin": "1234"}),
                    ("GET", "/api/auth/users", None), ("POST", "/api/auth/users", {"username": "eve", "password": "eve-password-1", "is_admin": True}),
                    ("POST", "/api/auth/users/ben/admin", {"is_admin": True}), ("DELETE", "/api/auth/users/ben", None),
                    ("POST", "/api/auth/logout", None), ("POST", "/api/auth/login", {"username": "ana", "password": PASSWORDS["ana"]}),
                    ("GET", "/api/remote/status", None), ("POST", "/api/remote/disable", None), ("POST", "/api/remote/enable", {}),
                    ("GET", "/api/system/backup/full", None), ("POST", "/api/system/wipe", {"kinds": []}), ("GET", "/api/system/wipe-kinds", None)]
        for method, path, body in refusals:
            r = self.ana.request(method, path, json=body)
            self.assertEqual((r.status_code, r.json()), (403, {"detail": phone_devices.DESKTOP_ONLY_MESSAGE}), f"{method} {path}")
        self.assertNotIn("eve", auth_manager._users["users"])
        self.assertFalse(auth_manager.is_admin("ben"))
        self.assertTrue(auth_manager.verify_password("ana", PASSWORDS["ana"]))
        self.assertFalse(phone_devices.pairing_waiting("ana"), "a phone cannot start pairing another phone")
        self.assertEqual(self.ana.get("/api/auth/status").status_code, 200, "who am I stays open")

    def test_no_spelling_of_a_desktop_only_path_slips_past(self):
        for path in ("/api/auth/users/", "/api/auth//users", "//api/auth/users", "/api/remote/", "/api/remote",
                     "/api/auth/status/x", "/api/system/backup", "/api/system/backup/full/", "/api/phone/pair/start/",
                     "/api/phone//pair/start", "/api/auth/cli/session"):
            self.assertFalse(phone_devices.route_allowed(path), path)
        for path in ("/api/auth/status", "/api/auth/status/", "/api/notes", "/api/phone/pair/claim", "/api/phone/devices", "/api/system/status",
                     "/api/authors", "/api/remotes"):
            self.assertTrue(phone_devices.route_allowed(path), path)
        for path in ("/api/auth/users/", "/api/remote/status/", "/api/phone/pair/start/"):
            r = self.ana.request("POST" if path.endswith("start/") else "GET", path, follow_redirects=False)
            self.assertEqual(r.status_code, 403, path)
        self.assertEqual(self.ana.get("/api/auth/users%2F").status_code, 403)
        self.assertNotEqual(self.ana.get("/api/%61uth/users").status_code, 200, "an escaped letter is the same path to the server")

    def test_the_route_dependency_refuses_a_desktop_only_path_even_without_the_middleware(self):
        from fastapi import Depends, FastAPI
        bare = FastAPI()

        @bare.get("/api/auth/users")
        async def users(user: str = Depends(middleware.require_user)):
            return {"user": user}

        @bare.get("/api/notes")
        async def notes(user: str = Depends(middleware.require_user)):
            return {"user": user}

        client = TestClient(bare, headers={"Authorization": f"Bearer {self.ana_token}"})
        self.assertEqual(client.get("/api/notes").json(), {"user": "ana"})
        self.assertEqual(client.get("/api/auth/users").status_code, 401)

    def test_with_accounts_off_a_token_opens_nothing(self):
        with patch.dict(os.environ, {"AUTH_ENABLED": "false"}), patch.object(settings_store, "get_setting", return_value=False), \
                patch("core.auth.UI_SECRET", "window-only-secret"), patch("core.middleware.auth_module.UI_SECRET", "window-only-secret"):
            self.assertIsNone(phone_devices.resolve(self.ana_token))
            self.assertEqual(self.ana.get("/api/notes").status_code, 401)

    def test_the_token_never_reaches_a_log(self):
        seen = []

        class Catch(logging.Handler):
            def emit(self, record):
                seen.append(record.getMessage() + " " + str(record.args) + " " + str(getattr(record, "exc_text", "")))

        handler = Catch(level=logging.DEBUG)
        root = logging.getLogger()
        level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            token, device_id = pair("ben")
            client = phone(token)
            client.get("/api/notes")
            client.get("/api/phone/session")
            client.get("/api/chat/live/snapshot")
            client.post("/api/phone/pair/start")
            TestClient(kairos.app, headers={"Authorization": f"Bearer {token}x"}).get("/api/notes")
            client.delete(f"/api/phone/devices/{device_id}")
            client.get("/api/notes")
        finally:
            root.removeHandler(handler)
            root.setLevel(level)
        text = "\n".join(seen)
        self.assertNotIn(token, text)
        self.assertNotIn(token[4:20], text)
        from core import logs
        self.assertNotIn(token[8:], logs.redact(f"GET /x Authorization: Bearer {token} and bare {token}"), "and the net under it masks one")


# -- streams and websockets ---------------------------------------------------------------------------------------

class LiveConnections(Base):
    """A stream or websocket opened with a phone's token is that account's, and ends when the phone is unpaired."""

    @staticmethod
    def mini_app():
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from fastapi.responses import StreamingResponse
        app = FastAPI()

        @app.websocket("/api/ws")
        async def echo(socket: WebSocket):
            user = middleware.get_current_user(socket)
            if user is None:
                await socket.close(1008)
                return
            await socket.accept()
            try:
                while True:
                    await socket.send_text(f"{user} in {accounts.current_account()}: " + (await socket.receive_text()))
            except WebSocketDisconnect:
                pass

        @app.get("/api/stream")
        async def stream():
            async def lines():
                n = 0
                while True:
                    n += 1
                    yield f"line {n}\n"
                    await asyncio.sleep(0.05)
            return StreamingResponse(lines(), media_type="text/event-stream")

        app.add_middleware(middleware.AccountContextMiddleware)
        return app

    def drive(self, app, path, token, end, settle=0.4):
        """Run an endless stream at the ASGI level (a test client would wait for it to finish), call `end` while it
        runs, and answer (everything sent, how much had been sent when `end` was called)."""
        async def run():
            sent = []

            async def receive():
                await asyncio.sleep(3600)  # the phone never hangs up on its own
                return {"type": "http.disconnect"}

            async def send(message):
                sent.append(message)

            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
                     "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
                     "headers": [(b"host", b"testserver"), (b"authorization", f"Bearer {token}".encode())],
                     "client": ("127.0.0.1", 5000), "server": ("testserver", 80)}
            stream = asyncio.ensure_future(app(scope, receive, send))
            await asyncio.sleep(settle)
            self.assertFalse(stream.done(), "streaming while the phone is paired")
            at_end = len(sent)
            await asyncio.to_thread(end)
            await asyncio.wait_for(stream, 8)  # ends instead of running forever
            return sent, at_end
        return asyncio.run(run())

    def test_a_token_opens_a_stream_and_unpairing_closes_it(self):
        token, device_id = pair("ana")
        sent, at_end = self.drive(self.mini_app(), "/api/stream", token, lambda: self.assertTrue(phone_devices.revoke("ana", device_id)))
        self.assertEqual(sent[0]["status"], 200)
        self.assertGreater(at_end, 2, "it was streaming")
        self.assertLessEqual(len(sent) - at_end, 2, "nothing more is sent after the phone is unpaired")

    def test_the_real_live_event_stream_takes_the_token_and_closes_on_unpair(self):
        token, device_id = pair("ana")
        sent, at_end = self.drive(kairos.app, "/api/chat/live/events", token,
                                  lambda: self.assertEqual(BROWSERS["ana"].delete(f"/api/phone/devices/{device_id}").status_code, 204))
        self.assertEqual(sent[0]["status"], 200)
        first = b"".join(m.get("body", b"") for m in sent[1:at_end]).decode()
        self.assertIn('"type": "snapshot"', first)
        self.assertLessEqual(len(sent) - at_end, 2)

    def test_an_unknown_token_gets_no_stream(self):
        r = TestClient(kairos.app, headers={"Authorization": "Bearer kph_" + "C" * 43}).get("/api/chat/live/events")
        self.assertEqual(r.status_code, 401)

    def test_a_token_opens_a_websocket_as_its_own_account_and_unpairing_closes_it(self):
        from starlette.websockets import WebSocketDisconnect
        token, device_id = pair("ben")
        client = TestClient(self.mini_app())
        with client.websocket_connect("/api/ws", headers={"Authorization": f"Bearer {token}"}) as socket:
            socket.send_text("hello")
            self.assertEqual(socket.receive_text(), f"ben in {auth_manager.account_id('ben')}: hello")
            self.assertTrue(phone_devices.revoke("ben", device_id))
            with self.assertRaises(WebSocketDisconnect) as closed:
                for _ in range(3):
                    socket.send_text("still there?")
                    socket.receive_text()
            self.assertEqual(closed.exception.code, 4401)

    def test_a_removed_or_unknown_token_cannot_open_a_websocket(self):
        from starlette.websockets import WebSocketDisconnect
        token, device_id = pair("ben")
        phone_devices.revoke("ben", device_id)
        for dead in (token, "kph_" + "D" * 43):
            with self.assertRaises(WebSocketDisconnect):
                with TestClient(self.mini_app()).websocket_connect("/api/ws", headers={"Authorization": f"Bearer {dead}"}):
                    pass

    def test_a_token_whose_account_is_deleted_closes_its_websocket_on_the_recheck(self):
        from starlette.websockets import WebSocketDisconnect
        token, device_id = pair("ben")
        with patch.object(middleware, "SESSION_RECHECK_SECONDS", 0.1):
            with TestClient(self.mini_app()).websocket_connect("/api/ws", headers={"Authorization": f"Bearer {token}"}) as socket:
                socket.send_text("hello")
                socket.receive_text()
                # The row is still there, but it no longer matches the account (as after a delete that missed its listener).
                phone_devices._store.devices[device_id]["account_id"] = "someoneelse"
                time.sleep(0.4)
                with self.assertRaises(WebSocketDisconnect):
                    for _ in range(3):
                        socket.send_text("still there?")
                        socket.receive_text()
        phone_devices._store.devices[device_id]["account_id"] = auth_manager.account_id("ben")
        phone_devices.revoke("ben", device_id)


# -- two accounts, and ending a token ---------------------------------------------------------------------------

class IsolationAndRevoke(Base):
    def test_one_accounts_phone_sees_and_removes_only_its_own_phones(self):
        ana_token, ana_device = pair("ana", device_name="Ana phone")
        ben_token, ben_device = pair("ben", device_name="Ben phone")
        ana, ben = phone(ana_token), phone(ben_token)
        self.assertNotIn(ben_device, ana.get("/api/phone/devices").text)
        self.assertNotIn("Ben phone", ana.get("/api/phone/devices").text)
        self.assertNotIn(ana_device, BROWSERS["ben"].get("/api/phone/devices").text)
        for client in (ana, BROWSERS["ana"]):
            r = client.delete(f"/api/phone/devices/{ben_device}")
            self.assertEqual(r.status_code, 404, "another account's phone is not there to remove, admin or not")
        self.assertEqual(ben.get("/api/phone/session").status_code, 200, "and it still works")
        self.assertEqual(ana.delete("/api/phone/devices/not-an-id").status_code, 422)
        self.assertEqual(ana.delete("/api/phone/devices/d_" + "0" * 24).status_code, 404)
        for name, device_id in (("ana", ana_device), ("ben", ben_device)):
            phone_devices.revoke(name, device_id)

    def test_unpairing_ends_the_token_at_once(self):
        token, device_id = pair("ana")
        other_token, other_device = pair("ana")
        client = phone(token)
        self.assertEqual(client.get("/api/notes").status_code, 200)
        gone = client.delete(f"/api/phone/devices/{device_id}")
        self.assertEqual((gone.status_code, gone.content), (204, b""))
        self.assertEqual(client.get("/api/notes").status_code, 401)
        self.assertEqual(client.get("/api/phone/session").status_code, 401)
        self.assertNotIn(device_id, BROWSERS["ana"].get("/api/phone/devices").text)
        self.assertNotIn(hashlib.sha256(token.encode()).hexdigest(), Path(phone_devices.DEVICES_FILE).read_text(encoding="utf-8"))
        self.assertEqual(phone(other_token).get("/api/phone/session").status_code, 200, "her other phone stays")
        phone_devices.revoke("ana", other_device)

    def test_a_browser_unpairs_a_phone_but_not_on_another_sites_say_so(self):
        token, device_id = pair("ana")
        r = BROWSERS["ana"].delete(f"/api/phone/devices/{device_id}", headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(phone(token).get("/api/phone/session").status_code, 200)
        self.assertEqual(BROWSERS["ana"].delete(f"/api/phone/devices/{device_id}").status_code, 204)
        self.assertEqual(phone(token).get("/api/phone/session").status_code, 401)

    def test_a_password_change_a_reset_and_a_deleted_account_all_end_its_phones(self):
        admin = BROWSERS["ana"]
        for name in ("cy", "dee", "eli"):
            self.assertEqual(admin.post("/api/auth/users", json={"username": name, "password": f"{name}-password-1"}).status_code, 200)
            PASSWORDS[name] = f"{name}-password-1"
            BROWSERS[name] = browser(name)
        tokens = {name: pair(name)[0] for name in ("cy", "dee", "eli")}
        for name in tokens:
            self.assertEqual(phone(tokens[name]).get("/api/phone/session").status_code, 200)
        # cy changes his own password; an admin resets dee's; eli is deleted.
        r = BROWSERS["cy"].post("/api/auth/password", json={"current_password": PASSWORDS["cy"], "new_password": "cy-password-2"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(admin.post("/api/auth/users/dee/password", json={"new_password": "dee-password-2"}).status_code, 200)
        self.assertEqual(admin.delete("/api/auth/users/eli").status_code, 200)
        for name in tokens:
            self.assertEqual(phone(tokens[name]).get("/api/phone/session").status_code, 401, name)
            self.assertEqual(phone(tokens[name]).get("/api/notes").status_code, 401, name)
        # A new account under a deleted account's name is a different account: the old token stays dead.
        self.assertEqual(admin.post("/api/auth/users", json={"username": "eli", "password": "eli-password-3"}).status_code, 200)
        self.assertEqual(phone(tokens["eli"]).get("/api/phone/session").status_code, 401)
        for name in ("cy", "dee", "eli"):
            admin.delete(f"/api/auth/users/{name}")

    def test_a_row_left_behind_for_a_deleted_account_never_opens_its_successor(self):
        admin = BROWSERS["ana"]
        self.assertEqual(admin.post("/api/auth/users", json={"username": "fay", "password": "fay-password-1"}).status_code, 200)
        PASSWORDS["fay"] = "fay-password-1"
        BROWSERS["fay"] = browser("fay")
        token, device_id = pair("fay")
        row = dict(phone_devices._store.devices[device_id])
        self.assertEqual(admin.delete("/api/auth/users/fay").status_code, 200)
        self.assertEqual(admin.post("/api/auth/users", json={"username": "fay", "password": "fay-password-2"}).status_code, 200)
        phone_devices._store.devices[device_id] = row          # as if the delete had not cleaned up
        phone_devices._store.by_hash[row["token_hash"]] = device_id
        try:
            self.assertEqual(phone(token).get("/api/phone/session").status_code, 401)
        finally:
            phone_devices._store.devices.pop(device_id, None)
            phone_devices._store.by_hash.pop(row["token_hash"], None)
            admin.delete("/api/auth/users/fay")


# -- home and rings ---------------------------------------------------------------------------------------------

class HomeAndRings(Base):
    @classmethod
    def setUpClass(cls):
        reset_limits()
        cls.ana_token, cls.ana_device = pair("ana")
        cls.ben_token, cls.ben_device = pair("ben")
        cls.ana, cls.ben = phone(cls.ana_token), phone(cls.ben_token)

    def test_home_is_one_small_read_of_the_callers_own_things(self):
        self.assertEqual(TestClient(kairos.app).get("/api/phone/home").status_code, 401)
        soon = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
        later = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7200))
        r = self.ana.post("/api/calendar/events", json={"title": "Report due", "start": soon, "end": later})
        self.assertLess(r.status_code, 300, r.text)
        home = self.ana.get("/api/phone/home")
        self.assertEqual(home.status_code, 200, home.text)
        body = home.json()
        self.assertEqual(set(body), {"usage", "next_event", "needs_you", "running"})
        self.assertEqual(body["next_event"], {"title": "Report due", "starts_at": soon, "all_day": False})
        self.assertEqual((body["usage"], body["needs_you"], body["running"]), ([], 0, 0))
        theirs = self.ben.get("/api/phone/home").json()
        self.assertIsNone(theirs["next_event"], "ben has no events, and never sees ana's")
        self.assertEqual(BROWSERS["ana"].get("/api/phone/home").json()["next_event"]["title"], "Report due", "a browser may read it too")

    def test_home_counts_usage_running_work_and_what_needs_you(self):
        from services import chat_live, phone_home
        session_id = self.ana.post("/api/sessions", json={"title": "Working chat"}).json()["id"]
        overlay = {"providers": [{"provider": "claude", "windows": [{"name": "5h", "used_percent": 12.4, "resets_at": 1900000000},
                                                                    {"name": "week", "used_percent": 63.6, "resets_at": 1900003600}]},
                                 {"provider": "codex", "windows": []}], "models": []}

        async def fake_overlay(*a, **k):
            return overlay

        with patch("core.quota_usage.get_usage_overlay_async", fake_overlay), \
                patch.dict(chat_live._runs, {session_id: {"turnId": "t1", "status": "processing", "permission": {"id": "p1"}}}), \
                patch("services.bot_attention.inbox", return_value={"count": 2}):
            mine = self.ana.get("/api/phone/home").json()
            theirs = self.ben.get("/api/phone/home").json()
        self.assertEqual(mine["usage"], [{"provider": "Claude", "percent": 64, "resets_at": "2030-03-17T18:46:40Z"}],
                         "the fullest window of each plan, and a plan with no reading is left out")
        self.assertEqual((mine["running"], mine["needs_you"]), (1, 3), "two in the bots inbox and one chat stopped on a permission")
        self.assertEqual((theirs["running"], theirs["needs_you"]), (0, 2), "ana's running chat is not ben's")
        self.assertEqual(phone_home.iso(0), "1970-01-01T00:00:00Z")

    def test_a_part_that_cannot_be_read_is_left_empty(self):
        async def broken(*a, **k):
            raise RuntimeError("no quota today")

        with patch("core.quota_usage.get_usage_overlay_async", broken), patch("services.bot_attention.inbox", side_effect=RuntimeError("x")), \
                self.assertLogs("services.phone_home", level="ERROR"):
            r = self.ana.get("/api/phone/home")
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["usage"], r.json()["needs_you"]), ([], 0))

    def ring(self, name, **fields):
        account = auth_manager.account_id(name)
        now = time.time()
        ring = {"id": uuid.uuid4().hex, "bot_id": "bot1", "agent_id": "bot1", "bot_name": "Kip", "owner": name,
                "reason": "THE-PRIVATE-REASON", "created_at": now, "expires_at": now + 41, "status": rings.RINGING,
                "invocation_id": uuid.uuid4().hex, **fields}
        with rings._lock:
            rings._save(account, rings._load(account) + [ring])
        return ring

    def test_a_rings_state_is_the_callers_own_and_says_who_never_why(self):
        ring = self.ring("ana")
        r = self.ana.get(f"/api/rings/{ring['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual({k: body[k] for k in ("id", "agent_id", "bot_name", "status")},
                         {"id": ring["id"], "agent_id": "bot1", "bot_name": "Kip", "status": "ringing"})
        self.assertEqual(set(body), {"id", "agent_id", "bot_name", "status", "seconds_left"})
        self.assertTrue(38 <= body["seconds_left"] <= 41, body)
        self.assertNotIn("THE-PRIVATE-REASON", r.text)
        self.assertEqual(self.ben.get(f"/api/rings/{ring['id']}").status_code, 404, "another account's ring is not there")
        self.assertEqual(TestClient(kairos.app).get(f"/api/rings/{ring['id']}").status_code, 401)
        self.assertEqual(self.ana.get("/api/rings/" + "0" * 32).status_code, 404)
        self.assertEqual(self.ana.get("/api/rings/not-a-ring").status_code, 422)
        self.assertIn("rings", self.ana.get("/api/rings/pending").json(), "the pending list still answers at its own path")

    def test_a_ring_reads_answered_declined_or_expired(self):
        with patch.object(rings, "_close_push"), patch.object(rings, "_missed_item"):
            answered, declined, ran_out = self.ring("ana", status=rings.ANSWERED), self.ring("ana", status=rings.DECLINED), \
                self.ring("ana", expires_at=time.time() - 1)
            states = {name: self.ana.get(f"/api/rings/{ring['id']}").json() for name, ring in
                      (("answered", answered), ("declined", declined), ("expired", ran_out))}
        self.assertEqual({name: s["status"] for name, s in states.items()},
                         {"answered": "answered", "declined": "declined", "expired": "expired"})
        self.assertEqual({s["seconds_left"] for s in states.values()}, {0})


# -- native push --------------------------------------------------------------------------------------------------

class Relay:
    """A stand-in for the Kairos push relay (kairos-ios relay/): the same routes, the same signature check, written
    here from its README rather than from the desktop's own signing code, so a mistake in one cannot hide in the other."""
    ALERTS = ("message", "needs_you", "approval", "done")

    def __init__(self):
        self.installs, self.seen, self.denied, self.pushes, self.deleted = {}, [], 0, [], []
        self.answers = []           # statuses to answer the next pushes with, instead of sending
        self.takes_ring_end = False
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=None, headers=None):
                raw = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def handle_any(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                relay.seen.append((self.command, self.path, raw.decode(), dict(self.headers)))
                if self.command == "POST" and self.path == "/v1/installs":
                    body = json.loads(raw)
                    if not re.fullmatch(r"[0-9a-f]{64,200}", body.get("apns_token") or "") or body.get("environment") not in ("sandbox", "production"):
                        return self.reply(400, {"error": "bad_apns_token", "message": "x"})
                    install_id, secret = "inst" + uuid.uuid4().hex[:16], "sec" + uuid.uuid4().hex + uuid.uuid4().hex
                    relay.installs[install_id] = {"verifier": hashlib.sha256(secret.encode()).hexdigest(), "secret": secret, **body}
                    return self.reply(201, {"install_id": install_id, "secret": secret})
                match = re.fullmatch(r"/v1/installs/([A-Za-z0-9_-]{16,64})(/push)?", self.path)
                install = relay.installs.get(match.group(1)) if match else None
                if not match:
                    return self.reply(404, {"error": "not_found", "message": "x"})
                if not install or not self.signed(install, raw):
                    relay.denied += 1
                    return self.reply(401, {"error": "unauthorized", "message": "Missing or invalid signature."})
                if self.command == "DELETE":
                    relay.deleted.append(match.group(1))
                    del relay.installs[match.group(1)]
                    return self.reply(204)
                if self.command == "PUT":
                    install.update(json.loads(raw))
                    return self.reply(204)
                body = json.loads(raw)
                problem = relay.check(body, install)
                if problem:
                    return self.reply(*problem)
                if relay.answers:
                    status = relay.answers.pop(0)
                    return self.reply(status, {"error": "told_to", "message": "x"}, {"Retry-After": "7"} if status == 429 else None)
                relay.pushes.append((match.group(1), body))
                return self.reply(200, {"ok": True, "apns_id": "apns-1"})

            def signed(self, install, raw):
                stamp, signature = self.headers.get("X-Kairos-Timestamp", ""), self.headers.get("X-Kairos-Signature", "")
                if not stamp.isdigit() or abs(time.time() - int(stamp)) > 120:
                    return False
                text = f"{stamp}\n{self.command}\n{self.path}\n{hashlib.sha256(raw).hexdigest()}"
                wanted = hmac.new(install["verifier"].encode(), text.encode(), hashlib.sha256).hexdigest()
                return hmac.compare_digest(wanted, signature)

            do_POST = do_PUT = do_DELETE = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def check(self, body, install):
        """What the real relay refuses (its apns.js builders), so a shape it would reject fails here too."""
        allowed = {"alert": {"kind", "what", "who", "collapse_id", "notice", "title", "link", "request_id", "thread_id",
                             "activity_id", "activity_kind"},
                   "ring": {"kind", "ring_id", "expires_at", "who"},
                   "activity": {"kind", "event", "push_token", "content_state", "stale_date", "dismissal_date"}}
        if self.takes_ring_end:     # not in the real relay yet; switched on by the one test that looks ahead
            allowed["ring_end"] = {"kind", "ring_id", "outcome"}
        if body.get("kind") not in allowed or set(body) - allowed[body["kind"]]:
            return 400, {"error": "bad_kind", "message": "x"}
        if body["kind"] == "alert" and "notice" not in body and body.get("what") not in self.ALERTS:
            return 400, {"error": "bad_what", "message": "x"}
        if body["kind"] == "alert" and "notice" in body and body["notice"] not in ("approval", "question", "replyReady", "workDone", "workFailed"):
            return 400, {"error": "bad_notice", "message": "x"}
        if body["kind"] == "ring":
            if not isinstance(body.get("expires_at"), int) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(body.get("ring_id"))):
                return 400, {"error": "bad_ring", "message": "x"}
            if body["expires_at"] - time.time() < 3:
                return 409, {"error": "ring_expired", "message": "x"}
            if body["expires_at"] - time.time() > 300:
                return 400, {"error": "bad_expires_at", "message": "x"}
            if not install.get("voip_token"):
                return 409, {"error": "no_token", "message": "x"}
        if body["kind"] == "activity":
            if body.get("event") not in ("update", "end") or not re.fullmatch(r"[0-9a-fA-F]{32,512}", str(body.get("push_token"))) \
                    or not isinstance(body.get("content_state"), dict):
                return 400, {"error": "bad_activity", "message": "x"}
        return None

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Push(Base):
    @classmethod
    def setUpClass(cls):
        reset_limits()
        cls.relay = Relay()

    @classmethod
    def tearDownClass(cls):
        cls.relay.close()
        settings_store.update_settings(**{phone_push.RELAY_SETTING: None})

    def setUp(self):
        super().setUp()
        self.token, self.device = pair("ana")
        self.ana = phone(self.token)
        self.ben_token, self.ben_device = pair("ben")
        self.ben = phone(self.ben_token)
        self.addCleanup(lambda: [phone_devices.revoke("ana", self.device), phone_devices.revoke("ben", self.ben_device)])
        for bucket in (self.relay.seen, self.relay.pushes, self.relay.deleted, self.relay.answers):
            bucket.clear()
        self.relay.installs.clear()
        self.relay.denied = 0
        with mobile_activity.database() as db:
            db.execute("DELETE FROM outbox")
            db.execute("DELETE FROM relay_removals")
        self.use_relay(self.relay.url)

    def use_relay(self, url):
        r = BROWSERS["ana"].put("/api/phone/push/relay", json={"url": url or ""})
        self.assertEqual(r.status_code, 200, r.text)

    def register(self, client=None, **fields):
        body = {"apns_token": APNS, "voip_token": None, "environment": "sandbox", "locale": "en-US", **fields}
        r = (client or self.ana).post("/api/phone/push/register", json=body)
        self.assertEqual((r.status_code, r.content), (204, b""), r.text)

    def deliver(self):
        async def run():
            async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
                await mobile_notifications.deliver_due(client)
        with mobile_activity.database() as db:   # bot pushes are held ten seconds for a burst to settle; not in a test
            db.execute("UPDATE outbox SET next_attempt=0 WHERE status='pending'")
        with patch.object(mobile_notifications.permissions, "pending_request", return_value=True):
            asyncio.run(run())

    def outbox(self, device=None):
        with mobile_activity.database() as db:
            return [dict(r) for r in db.execute("SELECT kind,status,attempts FROM outbox WHERE device_id=? ORDER BY rowid", (device or self.device,))]

    def run_for(self, client, owner, title="THE-PRIVATE-CHAT-TITLE", from_phone=True, who=""):
        # Started from the phone unless a test says otherwise, so a quick "reply ready" is not held back
        # (mobile_activity.QUIET_REPLY_SECONDS).
        session = client.post("/api/sessions", json={"title": title}).json()
        run_id = uuid.uuid4().hex
        mobile_activity.create_run(run_id, session, owner, None, "fp", who=who, from_phone=from_phone)
        mobile_activity.publish(run_id, {"chunk": "THE-PRIVATE-REPLY-TEXT"})
        return run_id, session["id"]

    # -- registration ---------------------------------------------------------------------------------------------
    def test_only_a_paired_phone_registers_and_only_for_itself(self):
        body = {"apns_token": APNS, "environment": "sandbox"}
        self.assertEqual(TestClient(kairos.app).post("/api/phone/push/register", json=body).status_code, 401)
        r = BROWSERS["ana"].post("/api/phone/push/register", json=body)
        self.assertEqual((r.status_code, r.json()), (403, {"detail": "Only a paired phone can do this."}))
        self.assertEqual(BROWSERS["ana"].delete("/api/phone/push/register").status_code, 403)
        for bad in ({"apns_token": "nothex" * 12, "environment": "sandbox"}, {"apns_token": APNS, "environment": "staging"},
                    {"apns_token": APNS[:20], "environment": "sandbox"}, {"apns_token": APNS, "environment": "sandbox", "voip_token": "zz"},
                    {"apns_token": APNS, "environment": "sandbox", "locale": "en US; drop"}, {"environment": "sandbox"}):
            self.assertEqual(self.ana.post("/api/phone/push/register", json=bad).status_code, 422, bad)
        self.register(voip_token=VOIP.upper())
        stored = mobile_activity.phone_registration(self.device)
        self.assertEqual((stored["apns_token"], stored["voip_token"], stored["environment"], stored["locale"]), (APNS, VOIP, "sandbox", "en-US"))
        self.assertIsNone(mobile_activity.phone_registration(self.ben_device), "stored per phone")
        self.register(apns_token=APNS2)
        self.assertEqual(mobile_activity.phone_registration(self.device)["apns_token"], APNS2, "sending again replaces it")
        with mobile_activity.database() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM devices WHERE id=?", (self.device,)).fetchone()[0], 1)
        self.assertEqual(self.relay.seen, [], "registering sends nothing: the relay hears of a phone when a push is due")
        self.assertEqual(self.ana.delete("/api/phone/push/register").status_code, 204)
        self.assertIsNone(mobile_activity.phone_registration(self.device))
        self.assertEqual(self.ana.delete("/api/phone/push/register").status_code, 204, "removing twice is fine")

    def test_a_phones_push_is_not_a_browser_enrollment(self):
        self.register()
        self.assertEqual(BROWSERS["ana"].get("/api/notifications").json()["devices"], [], "not listed with browser push")
        self.assertEqual(BROWSERS["ana"].delete(f"/api/notifications/devices/{self.device}").status_code, 404)
        self.assertEqual(BROWSERS["ana"].post(f"/api/notifications/devices/{self.device}/test").status_code, 404)
        self.assertIsNotNone(mobile_activity.phone_registration(self.device))

    # -- the relay address ----------------------------------------------------------------------------------------
    def test_only_an_admin_in_a_browser_sets_the_relay_and_only_to_a_plain_https_address(self):
        self.assertEqual(BROWSERS["ben"].put("/api/phone/push/relay", json={"url": "https://relay.example"}).status_code, 403)
        self.assertEqual(BROWSERS["ana"].put("/api/phone/push/relay", json={"url": "https://relay.example"},
                                             headers={"Origin": "https://evil.example"}).status_code, 403)
        for bad in ("http://relay.example", "ftp://relay.example", "https://user:pw@relay.example", "https://relay.example/path",
                    "https://relay.example?x=1", "https://relay.example#f", "relay.example", "https://", "http://10.0.0.5:8787",
                    "https://relay.example:notaport", "https://relay .example"):
            r = BROWSERS["ana"].put("/api/phone/push/relay", json={"url": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(phone_push.relay_url(), self.relay.url, "a refused address changes nothing")
        self.assertEqual(BROWSERS["ana"].put("/api/phone/push/relay", json={"url": " https://relay.example/ "}).json(), {"url": "https://relay.example"})
        self.assertEqual(BROWSERS["ana"].get("/api/phone/push/relay").json(), {"url": "https://relay.example"})
        self.use_relay("")
        self.assertIsNone(phone_push.relay_url())

    def test_with_no_relay_address_nothing_is_queued_or_sent_and_nothing_breaks(self):
        self.use_relay("")
        self.register(voip_token=VOIP)
        run_id, _ = self.run_for(self.ana, "ana")
        self.assertEqual(self.ana.post("/api/phone/push/activity", json={"activity_id": run_id, "kind": "chat_run", "push_token": ACTIVITY_TOKEN}).status_code, 204)
        mobile_activity.publish(run_id, {}, "completed")
        mobile_activity.enqueue(run_id, "completed")
        mobile_activity.enqueue_bot("bot_needs_you", "bot1", auth_manager.is_admin, account=auth_manager.account_id("ana"))
        mobile_activity.enqueue_ring("ana", {"id": "r" * 32, "agent_id": "bot1", "bot_name": "Kip", "expires_at": time.time() + 60})
        self.assertEqual(self.outbox(), [])
        self.deliver()
        self.assertEqual(self.relay.seen, [])
        self.assertEqual(self.ana.delete(f"/api/phone/devices/{self.device}").status_code, 204)
        self.deliver()
        self.assertEqual(self.relay.seen, [], "not even the goodbye is sent anywhere")

    # -- sending --------------------------------------------------------------------------------------------------
    def test_a_finished_chat_reaches_the_phone_through_the_relay_signed_and_with_no_message_text(self):
        self.register()
        self.register(self.ben)
        run_id, session_id = self.run_for(self.ana, "ana")
        mobile_activity.publish(run_id, {}, "completed")
        mobile_activity.enqueue(run_id, "completed")
        self.deliver()
        self.assertEqual(self.relay.denied, 0, "every signed request passed the relay's own check")
        self.assertEqual([(m, p) for m, p, _, _ in self.relay.seen][0], ("POST", "/v1/installs"))
        self.assertEqual(json.loads(self.relay.seen[0][2]), {"apns_token": APNS, "voip_token": None, "environment": "sandbox"})
        self.assertEqual(len(self.relay.installs), 1, "only the phone with something due is registered")
        install_id = next(iter(self.relay.installs))
        # Who, what kind, the chat's title (the phone's Private level does not reach the desktop) and ids to open it.
        self.assertEqual(self.relay.pushes, [(install_id, {
            "kind": "alert", "what": "message", "who": "Kairos", "collapse_id": "kairos-" + run_id, "notice": "replyReady",
            "link": "kairos-agents://chat/" + session_id, "thread_id": "chat-" + session_id, "title": "THE-PRIVATE-CHAT-TITLE",
            "activity_id": run_id, "activity_kind": "reply"})])
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "sent", "attempts": 1}])
        self.assertEqual(self.outbox(self.ben_device), [], "ben's phone gets nothing of ana's")
        everything = json.dumps(self.relay.seen)
        for private in ("THE-PRIVATE-REPLY-TEXT", "ana", self.token, self.device):
            self.assertNotIn(private, everything)
        self.deliver()
        self.assertEqual(len(self.relay.pushes), 1, "sent once")

    def test_a_quick_reply_at_the_desktop_is_not_pushed_but_a_long_one_a_phones_and_the_rest_are(self):
        self.register()
        quick, _ = self.run_for(self.ana, "ana", from_phone=False, who="Claude Opus")
        mobile_activity.enqueue(quick, "completed")
        self.assertEqual(self.outbox(), [], "under 30 seconds and started at the desktop: the person was there")
        mobile_activity.enqueue(quick, "failed")
        mobile_activity.enqueue(quick, "permission", {"id": "p9", "expires_at": time.time() + 300})
        self.assertEqual([row["kind"] for row in self.outbox()], ["failed", "permission"], "failures and approvals always go")
        long_run, _ = self.run_for(self.ana, "ana", from_phone=False, who="Claude Opus")
        with mobile_activity.database() as db:
            row = db.execute("SELECT snapshot FROM activity WHERE id=?", (long_run,)).fetchone()
            snap = json.loads(row[0])
            snap["started_at"] -= mobile_activity.QUIET_REPLY_SECONDS
            db.execute("UPDATE activity SET snapshot=? WHERE id=?", (json.dumps(snap), long_run))
        mobile_activity.enqueue(long_run, "completed")
        phone_run, _ = self.run_for(self.ana, "ana", from_phone=True)
        mobile_activity.enqueue(phone_run, "completed")
        self.assertEqual([row["kind"] for row in self.outbox()], ["failed", "permission", "completed", "completed"])
        self.deliver()
        sent = [body for _, body in self.relay.pushes]
        self.assertEqual([(b["notice"], b["who"]) for b in sent],
                         [("workFailed", "Claude Opus"), ("approval", "Claude Opus"), ("replyReady", "Claude Opus"), ("replyReady", "Kairos")])
        self.assertEqual(sent[1]["request_id"], "p9")
        self.assertTrue(sent[1]["link"].startswith("kairos-agents://chat/"), "a model chat's approval opens the chat")

    def test_the_relays_secret_is_kept_encrypted_and_never_shown(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        mobile_activity.publish(run_id, {}, "completed")
        mobile_activity.enqueue(run_id, "completed")
        self.deliver()
        install_id, install = next(iter(self.relay.installs.items()))
        stored = mobile_activity.phone_registration(self.device)["relay"]
        self.assertEqual((stored["install_id"], stored["url"], stored["synced"]), (install_id, self.relay.url, True))
        self.assertNotEqual(stored["secret"], install["secret"])
        from core import secret_storage
        self.assertEqual(secret_storage.decrypt_install(stored["secret"]), install["secret"])
        db = sqlite3.connect(mobile_activity.DB_FILE)
        try:
            dump = "\n".join(db.iterdump())
        finally:
            db.close()
        self.assertNotIn(install["secret"], dump)
        for client in (self.ana, BROWSERS["ana"]):
            for path in ("/api/phone/devices", "/api/phone/session", "/api/notifications", "/api/settings", "/api/phone/home"):
                text = client.get(path).text
                self.assertNotIn(install["secret"], text, path)
                self.assertNotIn(stored["secret"], text, path)
                self.assertNotIn(APNS, text, path)

    def test_each_kind_maps_to_the_relays_words(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        mobile_activity.enqueue(run_id, "permission", {"id": "p1", "expires_at": time.time() + 300})
        mobile_activity.enqueue(run_id, "permission", {"id": "q1", "kind": "question", "expires_at": time.time() + 300})
        mobile_activity.enqueue(run_id, "failed")
        bot = BROWSERS["ana"].post("/api/agents", json={"name": "Scout"})
        self.assertLess(bot.status_code, 300, bot.text)
        bot_id = bot.json()["id"]
        with accounts.as_account(auth_manager.account_id("ana")):
            mobile_activity.enqueue_bot("bot_needs_you", bot_id, auth_manager.is_admin)
            mobile_activity.enqueue_bot("bot_results", bot_id, auth_manager.is_admin)
        self.deliver()
        sent = [body for _, body in self.relay.pushes]
        self.assertEqual([(b["kind"], b["what"], b["who"]) for b in sent],
                         [("alert", "approval", "Kairos"), ("alert", "needs_you", "Kairos"), ("alert", "needs_you", "Kairos"),
                          ("alert", "needs_you", "Scout"), ("alert", "done", "Scout")])
        self.assertEqual(self.relay.denied, 0)
        self.assertEqual({row["status"] for row in self.outbox()}, {"sent"})

    def test_a_bots_push_reaches_only_the_phones_of_its_own_account(self):
        self.register()
        auth_manager._users["users"]["ben"]["is_admin"] = True   # even were ben an admin, ana's bot is not his
        try:
            self.register(self.ben)
            with accounts.as_account(auth_manager.account_id("ana")):
                mobile_activity.enqueue_bot("bot_needs_you", "bot1", auth_manager.is_admin)
            mobile_activity.enqueue_bot("bot_results", "bot1", auth_manager.is_admin)   # no account known: no phone at all
        finally:
            auth_manager._users["users"]["ben"]["is_admin"] = False
        self.assertEqual([row["kind"] for row in self.outbox()], ["bot_needs_you"])
        self.assertEqual(self.outbox(self.ben_device), [])

    def test_a_ring_is_a_call_with_who_and_until_when_and_never_why(self):
        self.register(voip_token=VOIP)
        account = auth_manager.account_id("ana")
        now = time.time()
        ring = {"id": uuid.uuid4().hex, "bot_id": "bot1", "agent_id": "bot1", "bot_name": "Kip", "owner": "ana", "reason": "THE-PRIVATE-REASON",
                "created_at": now, "expires_at": now + 60, "status": rings.RINGING, "invocation_id": "i1"}
        with rings._lock:
            rings._save(account, [ring])
        mobile_activity.enqueue_ring("ana", ring)
        self.assertEqual(self.outbox(), [{"kind": "bot_call", "status": "pending", "attempts": 0}], "one push, not the browser's three")
        self.deliver()
        self.assertEqual(self.relay.denied, 0)
        (_, body), = self.relay.pushes
        self.assertEqual(body, {"kind": "ring", "ring_id": ring["id"], "who": "Kip", "expires_at": int(now + 60)})
        self.assertNotIn("THE-PRIVATE-REASON", json.dumps(self.relay.seen))
        # The ring ends: a browser would get a closing push; a phone asks GET /api/rings/{id} instead.
        rings.decline(account, "ana", ring["id"])
        self.deliver()
        self.assertEqual(len(self.relay.pushes), 1)
        self.assertEqual(self.ana.get(f"/api/rings/{ring['id']}").json()["status"], "declined")

    def test_the_end_of_a_ring_is_never_a_call_push(self):
        # The phone wants the end of a ring as a background push (every call push must show an incoming call). The relay
        # has no such push yet, so today nothing is queued or sent for it; the day it has one, this is what goes out.
        self.assertIsNone(phone_push.message_for("bot_call_end", {"ring_id": "r1", "outcome": "answered"}, {"voip_token": VOIP}))
        self.register(voip_token=VOIP)
        account = auth_manager.account_id("ana")
        now = time.time()
        ring = {"id": uuid.uuid4().hex, "bot_id": "bot1", "agent_id": "bot1", "bot_name": "Kip", "owner": "ana", "reason": "x",
                "created_at": now, "expires_at": now + 60, "status": rings.RINGING, "invocation_id": "i9"}
        with rings._lock:
            rings._save(account, [ring])
        self.relay.takes_ring_end = True
        self.addCleanup(setattr, self.relay, "takes_ring_end", False)
        with patch.object(phone_push, "RELAY_KINDS", phone_push.RELAY_KINDS | {"ring_end"}):
            mobile_activity.enqueue_ring("ana", ring)
            self.deliver()
            with patch.object(rings, "_missed_item"):
                rings.decline(account, "ana", ring["id"])
            self.assertEqual([row["kind"] for row in self.outbox()], ["bot_call", "bot_call_end"])
            self.deliver()
        self.assertEqual([body["kind"] for _, body in self.relay.pushes], ["ring", "ring_end"])
        self.assertEqual(self.relay.pushes[-1][1], {"kind": "ring_end", "ring_id": ring["id"], "outcome": "declined"})
        self.assertEqual(self.relay.denied, 0)

    def test_what_the_phone_reads_is_built_and_only_what_the_relay_takes_is_sent(self):
        # kairos-ios docs/coverage/native.md "Push payload": the fields a tap and the action buttons need.
        approval = phone_push.native_alert("permission", {"session_id": "s1", "run_id": "t1", "request_id": "p1", "agent_id": "b1",
                                                          "title": "Plan\nthe launch"})
        self.assertEqual(approval, {"notice": "approval", "link": "kairos-agents://approval/p1?bot=b1", "thread_id": "bot-b1",
                                    "title": "Plan the launch", "request_id": "p1", "activity_id": "t1", "activity_kind": "reply"})
        # A model chat's approval or question opens the chat, where it is shown, and keeps its request for the buttons.
        question = phone_push.native_alert("permission", {"session_id": "s1", "request_id": "q1", "ask": "question"})
        self.assertEqual((question["notice"], question["link"], question["request_id"], question["thread_id"]),
                         ("question", "kairos-agents://chat/s1", "q1", "chat-s1"))
        self.assertEqual(phone_push.native_alert("completed", {"session_id": "s1", "run_id": "t1"})["link"], "kairos-agents://chat/s1")
        self.assertEqual(phone_push.native_alert("completed", {"session_id": "s1"})["notice"], "replyReady")
        self.assertEqual(phone_push.native_alert("failed", {"session_id": "s1"})["notice"], "workFailed")
        self.assertEqual(phone_push.native_alert("bot_results", {"agent_id": "b1"}),
                         {"notice": "workDone", "link": "kairos-agents://bot/b1", "thread_id": "bot-b1"})
        self.assertEqual(phone_push.native_alert("bot_needs_you", {"agent_id": "b1"})["notice"], "question")
        # The relay takes the kind, who, the chat title, the link and the ids (relay/README.md); never message text.
        payload = {"session_id": "s1", "run_id": "t1", "request_id": "p1", "agent_id": "b1", "who": "Scout", "collapse_id": "kairos-t1",
                   "title": "Plan the launch", "text": "SECRET", "body": "SECRET"}
        self.assertEqual(phone_push.message_for("permission", payload, {}),
                         {"kind": "alert", "what": "approval", "who": "Scout", "collapse_id": "kairos-t1", "notice": "approval",
                          "link": "kairos-agents://approval/p1?bot=b1", "thread_id": "bot-b1", "title": "Plan the launch",
                          "request_id": "p1", "activity_id": "t1", "activity_kind": "reply"})
        ring = phone_push.message_for("bot_call", {"ring_id": "r1", "agent_id": "b1", "who": "Kip", "expires_at": time.time() + 60}, {"voip_token": VOIP})
        self.assertEqual(set(ring), {"kind", "ring_id", "who", "expires_at"})
        with patch.dict(phone_push.RELAY_FIELDS, {"ring": phone_push.RELAY_FIELDS["ring"] | {"agent_id", "bot_name"}}):
            ring = phone_push.message_for("bot_call", {"ring_id": "r1", "agent_id": "b1", "who": "Kip", "expires_at": time.time() + 60}, {"voip_token": VOIP})
            self.assertEqual((ring["agent_id"], ring["bot_name"]), ("b1", "Kip"))

    def test_a_ring_that_already_ended_is_not_sent_and_a_phone_without_a_call_token_gets_an_alert(self):
        self.register()   # no VoIP token
        account = auth_manager.account_id("ana")
        now = time.time()
        ring = {"id": uuid.uuid4().hex, "bot_id": "bot1", "agent_id": "bot1", "bot_name": "Kip", "owner": "ana", "reason": "x",
                "created_at": now, "expires_at": now + 60, "status": rings.RINGING, "invocation_id": "i2"}
        with rings._lock:
            rings._save(account, [ring])
        mobile_activity.enqueue_ring("ana", ring)
        self.deliver()
        # The old style "Kip needs you" (no notice kind for a ring); the relay passes a link on only with a notice.
        self.assertEqual([body for _, body in self.relay.pushes], [{"kind": "alert", "what": "needs_you", "who": "Kip", "collapse_id": "ring-" + ring["id"],
                                                                    "link": f"kairos-agents://ring/{ring['id']}?bot=bot1"}])
        self.relay.pushes.clear()
        ended = {**ring, "id": uuid.uuid4().hex, "status": rings.ANSWERED, "invocation_id": "i3"}
        with rings._lock:
            rings._save(account, [ended])
        mobile_activity.enqueue_ring("ana", ended)
        self.deliver()
        self.assertEqual(self.relay.pushes, [], "answered elsewhere before the push left: nothing rings")

    def test_a_live_activity_gets_generic_updates_for_the_callers_own_run_only(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        bens_run, _ = self.run_for(self.ben, "ben")
        body = {"activity_id": run_id, "kind": "chat_run", "push_token": ACTIVITY_TOKEN}
        self.assertEqual(BROWSERS["ana"].post("/api/phone/push/activity", json=body).status_code, 403, "a phone's own call")
        self.assertEqual(self.ana.post("/api/phone/push/activity", json={**body, "activity_id": bens_run}).status_code, 404, "not her run")
        self.assertEqual(self.ana.post("/api/phone/push/activity", json={**body, "activity_id": "nosuchrun"}).status_code, 404)
        for bad in ({**body, "kind": "anything"}, {**body, "push_token": "xyz"}, {**body, "activity_id": "a/b"},
                    {**body, "kind": "start"}, {**body, "activity_id": "push-to-start"}):
            self.assertEqual(self.ana.post("/api/phone/push/activity", json=bad).status_code, 422, bad)
        for kind in ("task", "team", "render", "forge", "call"):   # the phone's other kinds: taken for a run that is hers
            self.assertEqual(self.ana.post("/api/phone/push/activity", json={**body, "kind": kind}).status_code, 204, kind)
            self.assertEqual(self.ana.post("/api/phone/push/activity", json={**body, "kind": kind, "activity_id": "ring-or-job-1"}).status_code, 404, kind)
        start = self.ana.post("/api/phone/push/activity", json={"activity_id": "push-to-start", "kind": "start", "push_token": "e5" * 40})
        self.assertEqual(start.status_code, 204, "the push-to-start token is kept with the phone")
        self.assertEqual(mobile_activity.phone_registration(self.device)["push_to_start"]["push_token"], "e5" * 40)
        r = self.ana.post("/api/phone/push/activity", json={**body, "kind": "reply"})
        self.assertEqual((r.status_code, r.content), (204, b""))
        mobile_activity.publish(run_id, {"chunk": "MORE-PRIVATE-TEXT"})                     # no change of state: no push
        mobile_activity.publish(run_id, {"permission": {"id": "p1", "expires_at": time.time() + 300}})
        self.deliver()
        mobile_activity.publish(run_id, {"permission_closed": "p1"})
        mobile_activity.publish(run_id, {"tool_step": {"name": "PRIVATE-STEP"}})
        mobile_activity.publish(run_id, {}, "completed")
        self.deliver()
        sent = [body for _, body in self.relay.pushes]
        self.assertEqual([(b["kind"], b["event"], b["content_state"]["phase"], b["content_state"]["step"]) for b in sent],
                         [("activity", "update", "waiting", "Waiting for you"), ("activity", "update", "running", "Working"),
                          ("activity", "end", "done", "Done")])
        self.assertEqual({b["push_token"] for b in sent}, {ACTIVITY_TOKEN})
        # Every key the phone's ContentState decodes (kairos-ios KairosActivity.swift), and nothing of the chat's.
        state = sent[-1]["content_state"]
        self.assertEqual(set(state), {"phase", "step", "detail", "stage", "helpers", "startedAt", "muted"})
        self.assertEqual((state["detail"], state["stage"], state["helpers"], state["muted"]), ("", 0, [], False))
        started = mobile_activity.read_run(run_id)["snapshot"]["started_at"]
        self.assertAlmostEqual(state["startedAt"], started - 978307200, places=3, msg="seconds since 2001, as ActivityKit reads a Date")
        self.assertIn("stale_date", sent[0])
        self.assertIn("dismissal_date", sent[-1])
        for private in ("MORE-PRIVATE-TEXT", "PRIVATE-STEP", "THE-PRIVATE-CHAT-TITLE"):
            self.assertNotIn(private, json.dumps(self.relay.seen))
        self.assertEqual(mobile_activity.phone_registration(self.device)["activities"], {}, "an ended activity's token is forgotten")
        self.assertEqual(self.relay.denied, 0)

    def test_new_tokens_are_sent_to_the_relay_before_the_next_push(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        mobile_activity.enqueue(run_id, "failed")
        self.deliver()
        install_id = next(iter(self.relay.installs))
        self.register(apns_token=APNS2, voip_token=VOIP, environment="production")
        self.assertFalse(mobile_activity.phone_registration(self.device)["relay"]["synced"])
        mobile_activity.enqueue(run_id, "completed")
        self.deliver()
        calls = [(m, p) for m, p, _, _ in self.relay.seen]
        self.assertEqual(calls[-2:], [("PUT", f"/v1/installs/{install_id}"), ("POST", f"/v1/installs/{install_id}/push")])
        self.assertEqual({k: self.relay.installs[install_id][k] for k in ("apns_token", "voip_token", "environment")},
                         {"apns_token": APNS2, "voip_token": VOIP, "environment": "production"})
        self.assertEqual(len(self.relay.installs), 1, "the same registration, updated")
        self.assertEqual(self.relay.denied, 0)

    def test_what_the_relay_answers_decides_what_happens_next(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        # Busy (429 with Retry-After, 503): kept and tried again. Refused (422): dropped, not retried.
        mobile_activity.enqueue(run_id, "completed")
        self.relay.answers[:] = [429]
        self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "pending", "attempts": 1}])
        self.relay.answers[:] = [503]
        self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "pending", "attempts": 2}])
        self.relay.answers[:] = [422]
        self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "failed", "attempts": 3}])
        self.deliver()
        self.assertEqual(self.relay.pushes, [], "a refused push is not sent again")
        # The relay forgot this phone (401): register again and the retry goes through.
        self.relay.installs.clear()
        mobile_activity.enqueue(run_id, "failed")
        self.deliver()
        self.assertEqual(self.outbox()[-1], {"kind": "failed", "status": "pending", "attempts": 1})
        self.assertNotIn("relay", mobile_activity.phone_registration(self.device))
        self.deliver()
        self.assertEqual(self.outbox()[-1], {"kind": "failed", "status": "sent", "attempts": 2})
        self.assertEqual(len(self.relay.pushes), 1)
        # Apple says the phone's token is gone (410): the push registration is dropped, and the relay is told to forget it.
        mobile_activity.enqueue(run_id, "permission", {"id": "p7", "expires_at": time.time() + 300})
        self.relay.answers[:] = [410]
        self.deliver()
        self.assertIsNone(mobile_activity.phone_registration(self.device))
        self.assertEqual(self.outbox(), [])
        self.deliver()
        self.assertEqual(len(self.relay.deleted), 1)
        self.assertEqual(self.ana.get("/api/phone/session").status_code, 200, "the phone itself stays paired")

    def test_a_relay_that_is_down_or_misbehaves_never_breaks_the_sender(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        mobile_activity.enqueue(run_id, "completed")
        with patch.object(phone_push, "relay_url", return_value="http://127.0.0.1:9"):   # nothing listens there
            self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "pending", "attempts": 1}])

        async def odd(*args, **kwargs):
            return 201, 0, {"install_id": "../../etc", "secret": 7}

        with patch.object(mobile_notifications, "_relay", odd):
            self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "pending", "attempts": 2}])
        self.assertNotIn("relay", mobile_activity.phone_registration(self.device), "a malformed answer is not kept")
        self.deliver()
        self.assertEqual(self.outbox(), [{"kind": "completed", "status": "sent", "attempts": 3}])

    def test_unpairing_or_turning_push_off_removes_the_phone_at_the_relay(self):
        for end in (lambda: self.ana.delete("/api/phone/push/register"), lambda: BROWSERS["ana"].delete(f"/api/phone/devices/{self.device}")):
            self.register()
            run_id, _ = self.run_for(self.ana, "ana")
            mobile_activity.enqueue(run_id, "completed")
            self.deliver()
            install_id = next(iter(self.relay.installs))
            self.assertEqual(end().status_code, 204)
            self.assertIsNone(mobile_activity.phone_registration(self.device))
            self.assertEqual(self.outbox(), [])
            self.deliver()
            self.assertEqual(self.relay.deleted[-1], install_id)
            self.assertEqual(self.relay.installs, {})
            self.assertEqual(self.relay.denied, 0, "the goodbye is signed too")
            self.deliver()
            self.assertEqual(self.relay.deleted.count(install_id), 1, "asked once")
        self.assertEqual(self.ana.get("/api/phone/session").status_code, 401, "the second way was unpairing")

    def test_a_push_queued_for_a_phone_that_was_then_unpaired_is_never_sent(self):
        self.register()
        run_id, _ = self.run_for(self.ana, "ana")
        mobile_activity.enqueue(run_id, "completed")
        with patch.object(mobile_activity, "_phones_ended"), patch.object(phone_devices, "ended_listeners", []):
            phone_devices.revoke("ana", self.device)          # as if the cleanup listener had been missed
        self.deliver()
        self.assertEqual(self.relay.pushes, [])
        self.assertIsNone(mobile_activity.phone_registration(self.device))

    def test_nothing_about_push_reaches_a_log(self):
        seen = []

        class Catch(logging.Handler):
            def emit(self, record):
                seen.append(record.getMessage() + " " + str(getattr(record, "exc_text", "")))

        handler = Catch(level=logging.DEBUG)
        root = logging.getLogger()
        level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            self.register(voip_token=VOIP)
            run_id, _ = self.run_for(self.ana, "ana")
            mobile_activity.enqueue(run_id, "completed")
            self.deliver()
            secret = next(iter(self.relay.installs.values()))["secret"]
            mobile_activity.enqueue(run_id, "failed")
            with patch.object(mobile_notifications, "_relay", side_effect=RuntimeError(f"boom {secret} {APNS}")):
                self.deliver()
        finally:
            root.removeHandler(handler)
            root.setLevel(level)
        text = "\n".join(seen)
        for private in (secret, APNS, VOIP, self.token):
            self.assertNotIn(private, text)

    def test_the_signature_is_the_relays(self):
        # The relay's README, worked by hand: key = hex of SHA-256(secret); text = ts, METHOD, path, hex SHA-256 of the body.
        headers = phone_push.sign("s3cret", "post", "/v1/installs/abc/push", b'{"kind":"alert"}', timestamp=1800000000)
        key = hashlib.sha256(b"s3cret").hexdigest().encode()
        text = "1800000000\nPOST\n/v1/installs/abc/push\n" + hashlib.sha256(b'{"kind":"alert"}').hexdigest()
        self.assertEqual(headers, {"X-Kairos-Timestamp": "1800000000", "X-Kairos-Signature": hmac.new(key, text.encode(), hashlib.sha256).hexdigest()})
        empty = phone_push.sign("s3cret", "DELETE", "/v1/installs/abc", b"", timestamp=5)
        self.assertEqual(empty["X-Kairos-Signature"],
                         hmac.new(key, ("5\nDELETE\n/v1/installs/abc\n" + hashlib.sha256(b"").hexdigest()).encode(), hashlib.sha256).hexdigest())


if __name__ == "__main__":
    unittest.main(verbosity=1)
