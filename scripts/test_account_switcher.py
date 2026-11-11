"""The account switcher (David's ask 2026-11-11): each person signs in once on a device, then switching between
the accounts signed in on it is one click, with no password, like Google's. Security is the point of these tests:

- a device with sessions for A and B switches between them, and can never reach C (not signed in on it), not even
  with another device's tokens pasted into its cookie;
- signing out of A leaves B; signing out of all leaves none;
- an expired remembered sign-in asks for the password again; the first sign-in still asks the two-step code;
- the optional PIN is asked when switching in, and wrong tries are rate limited (locks, then the password);
- the switcher's routes refuse a request from another site (CSRF);
- while B is open, no route serves A's data (the leak test's own seeding and route sweep, run on one device);
- a push for A reaches the device only while A is the open account.

Runs the real app on a throwaway data folder (the leak test's, scripts/test_account_isolation.py, whose seeding and
route sweep it reuses).

    .venv\\Scripts\\python.exe -X utf8 scripts\\test_account_switcher.py
"""
import hashlib
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Sets up the throwaway data folder (AUTH_ENABLED on) and imports the app; only its helpers are used here.
from scripts.test_account_isolation import Account, fill, leaks_for, kairos  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from core import auth as auth_module  # noqa: E402
from core.auth import ACCOUNTS_COOKIE_NAME, DEVICE_COOKIE_NAME, SESSION_COOKIE_NAME, auth_manager  # noqa: E402
from core import middleware  # noqa: E402
from routes import auth_routes  # noqa: E402

PASSWORDS = {"ana": "ana-password-1", "ben": "ben-password-2", "cy": "cy-password-3"}
APP = {"X-Kairos-Switch": "1"}


def device() -> TestClient:
    """One browser or app window: its own cookie jar."""
    return TestClient(kairos.app)


def sign_in(client, name, **extra):
    r = client.post("/api/auth/login", json={"username": name, "password": PASSWORDS[name], **extra})
    assert r.status_code == 200, r.text
    return r


def who(client):
    return client.get("/api/auth/status").json()["username"]


def on_device(client):
    return {a["username"]: a for a in client.get("/api/auth/device-accounts").json()["accounts"]}


def switch(client, name, **body):
    return client.post("/api/auth/switch", json={"username": name, **body}, headers=APP)


def rows(client):
    """The server's remembered rows for this client's device (their ids never reach the client)."""
    return auth_manager.device_accounts(client.cookies.get(DEVICE_COOKIE_NAME))


def row_id(client, name):
    return next(r["id"] for r in rows(client) if r["username"] == name)


def copy_of(client):
    """Another browser holding a copy of this one's cookies (stolen, or a parallel request)."""
    other = device()
    for name in (DEVICE_COOKIE_NAME, SESSION_COOKIE_NAME):
        if client.cookies.get(name):
            other.cookies.set(name, client.cookies.get(name), domain="testserver.local")
    return other


class SwitcherBase(unittest.TestCase):
    def setUp(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        setup = device()
        assert setup.post("/api/auth/setup", json={"username": "ana", "password": PASSWORDS["ana"]}).status_code == 200
        for name in ("ben", "cy"):
            r = setup.post("/api/auth/users", json={"username": name, "password": PASSWORDS[name]})
            assert r.status_code == 200, r.text
        self.device = device()
        sign_in(self.device, "ana")
        sign_in(self.device, "ben")  # "Add another account": ben is now open, ana stays remembered


class Switching(SwitcherBase):
    def test_a_device_switches_between_its_accounts_with_no_password(self):
        self.assertEqual(who(self.device), "ben")
        self.assertEqual(set(on_device(self.device)), {"ana", "ben"})
        self.assertTrue(on_device(self.device)["ben"]["active"])
        r = switch(self.device, "ana")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(who(self.device), "ana")
        self.assertTrue(on_device(self.device)["ana"]["active"])
        self.assertEqual(switch(self.device, "ben").status_code, 200)
        self.assertEqual(who(self.device), "ben")
        self.assertEqual(switch(self.device, "ben").json()["username"], "ben", "switching to the open one is a no-op")

    def test_switching_closes_the_session_that_was_open(self):
        ben_session = self.device.cookies.get(SESSION_COOKIE_NAME)
        switch(self.device, "ana")
        self.assertIsNone(auth_manager.validate_session(ben_session), "the device holds one session at a time")
        stolen = device(); stolen.cookies.set(SESSION_COOKIE_NAME, ben_session)
        self.assertIsNone(who(stolen))

    def test_a_device_cannot_reach_an_account_not_signed_in_on_it(self):
        for name in ("cy", "nobody"):
            r = switch(self.device, name)
            self.assertEqual(r.status_code, 404, name)
            self.assertEqual(r.json()["detail"], "That account is not signed in on this device.", "same answer: no account oracle")
        self.assertEqual(who(self.device), "ben")
        self.assertNotIn("cy", on_device(self.device), "the switcher lists only this device's accounts")

    def test_another_devices_tokens_do_not_open_an_account(self):
        other = device(); sign_in(other, "cy")
        # A session token is not a device secret: pasted into the device cookie it opens nothing.
        probe = copy_of(self.device); probe.cookies.set(DEVICE_COOKIE_NAME, other.cookies.get(SESSION_COOKIE_NAME))
        self.assertEqual(switch(probe, "cy").status_code, 404)
        self.assertEqual(switch(probe, "ana").status_code, 404)
        # A remembered row is not a session, and its id never reaches the client in any cookie.
        cy_row = row_id(other, "cy")
        self.assertNotIn(cy_row, [c.value for c in other.cookies.jar])
        probe = device(); probe.cookies.set(SESSION_COOKIE_NAME, cy_row)
        self.assertIsNone(who(probe))
        self.assertEqual(probe.get("/api/notes").status_code, 401)

    def test_a_copied_device_cookie_dies_when_the_device_switches(self):
        thief = copy_of(self.device)
        self.assertEqual(switch(self.device, "ana").status_code, 200)
        self.assertEqual(switch(thief, "ana").status_code, 404, "the secret rotated on the switch")
        self.assertEqual(switch(thief, "ben").status_code, 404)
        self.assertEqual(on_device(thief), {})
        self.assertEqual(who(self.device), "ana", "the owner's device carries on")

    def test_a_copied_device_cookie_dies_on_sign_out_of_that_account(self):
        thief = copy_of(self.device)
        self.device.post("/api/auth/sign-out-account", json={"username": "ana"}, headers=APP)
        self.assertEqual(switch(thief, "ana").status_code, 404)
        self.assertEqual(switch(self.device, "ana").status_code, 404)

    def test_a_password_change_revokes_the_accounts_other_sign_ins(self):
        laptop = device(); sign_in(laptop, "ana"); sign_in(laptop, "cy")  # ana remembered on a second device
        switch(self.device, "ana")
        r = self.device.post("/api/auth/password", json={"current_password": PASSWORDS["ana"], "new_password": "ana-new-password-9"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(who(self.device), "ana", "the session that changed it stays")
        laptop_view = on_device(laptop)
        self.assertNotIn("ana", laptop_view, "ana's sign-in on the other device is revoked")
        self.assertEqual(switch(laptop, "ana").status_code, 404)
        self.assertIn("cy", laptop_view, "other accounts on that device stay")
        switch(self.device, "ben")
        self.assertEqual(switch(self.device, "ana").status_code, 200, "this device keeps ana")

    def test_a_remembered_sign_in_lives_no_longer_than_its_session(self):
        ben = next(s for s in auth_manager._sessions.values() if s.get("kind") == "remember" and s["username"] == "ben"
                   and s.get("device"))
        session = auth_manager._sessions[self.device.cookies.get(SESSION_COOKIE_NAME)]
        self.assertEqual(ben["expires_at"], session["expires_at"])
        switch(self.device, "ana"); switch(self.device, "ben")
        reopened = auth_manager._sessions[self.device.cookies.get(SESSION_COOKIE_NAME)]
        self.assertEqual(reopened["expires_at"], ben["expires_at"], "switching never extends it")

    def test_overlapping_switches_leave_one_live_session(self):
        sign_in(self.device, "cy")  # ana, ben, cy on the device; cy open
        first, second = copy_of(self.device), copy_of(self.device)  # two requests with the same cookies
        self.assertEqual(switch(first, "ben").status_code, 200)
        self.assertEqual(switch(second, "ana").status_code, 404, "the second carries the rotated-out secret")
        self.assertEqual(who(first), "ben")

    def test_parallel_switches_leave_at_most_one_live_session(self):
        import threading
        sign_in(self.device, "cy")
        clients = {name: copy_of(self.device) for name in ("ana", "ben")}
        results = {}
        threads = [threading.Thread(target=lambda n=n: results.__setitem__(n, switch(clients[n], n).status_code)) for n in clients]
        for t in threads: t.start()
        for t in threads: t.join()
        live = [c.cookies.get(SESSION_COOKIE_NAME) for c in clients.values() if auth_manager.validate_session(c.cookies.get(SESSION_COOKIE_NAME) or "")]
        self.assertEqual(sorted(results.values()), [200, 404], "serialized: one wins, the other finds the secret rotated")
        self.assertEqual(len(live), 1)
        winner = next(clients[n] for n, code in results.items() if code == 200)
        mine = hashlib.sha256(winner.cookies.get(DEVICE_COOKIE_NAME, domain="testserver.local").encode()).hexdigest()
        device_sessions = [t for t, v in list(auth_manager._sessions.items()) if v.get("device") == mine
                           and v.get("kind") != "remember" and auth_manager.validate_session(t)]
        self.assertEqual(len(device_sessions), 1, "the device holds one live session")

    def test_a_switch_closes_every_session_the_device_holds(self):
        device_secret = self.device.cookies.get(DEVICE_COOKIE_NAME)
        first = auth_manager.device_switch(device_secret, "ana", None)
        self.assertTrue(first["ok"])
        stray = first["session"]  # a session the request did not carry (a parallel switch's)
        second = auth_manager.device_switch(first["device"], "ben", None)
        self.assertTrue(second["ok"])
        self.assertIsNone(auth_manager.validate_session(stray))
        ana_id = next(r["id"] for r in auth_manager.device_accounts(second["device"]) if r["username"] == "ana")
        self.assertFalse(auth_manager.notification_session_valid("ana", hashlib.sha256(ana_id.encode()).hexdigest()),
                         "no push for ana while ben is open")

    def test_signing_out_of_one_account_leaves_the_other(self):
        ana_token = row_id(self.device, "ana")
        r = self.device.post("/api/auth/sign-out-account", json={"username": "ana"}, headers=APP)
        self.assertEqual(r.json(), {"ok": True, "was_open": False, "remaining": ["ben"]})
        self.assertEqual(set(on_device(self.device)), {"ben"})
        self.assertEqual(who(self.device), "ben", "the open account is untouched")
        self.assertEqual(switch(self.device, "ana").status_code, 404)
        self.assertNotIn(ana_token, auth_manager._sessions, "ana's remembered sign-in is gone from the server too")

    def test_signing_out_of_the_open_account_leaves_the_others_one_click_away(self):
        r = self.device.post("/api/auth/logout")
        self.assertEqual(r.json(), {"ok": True, "remaining": ["ana"]})
        self.assertIsNone(who(self.device))
        self.assertEqual(set(on_device(self.device)), {"ana"})
        self.assertEqual(switch(self.device, "ana").status_code, 200)
        self.assertEqual(who(self.device), "ana")

    def test_sign_out_of_all(self):
        mine = [r["id"] for r in rows(self.device)] + [self.device.cookies.get(SESSION_COOKIE_NAME)]
        self.assertEqual(self.device.post("/api/auth/logout-all", headers=APP).json(), {"ok": True})
        self.assertIsNone(who(self.device))
        self.assertEqual(on_device(self.device), {})
        self.assertFalse([t for t in mine if t in auth_manager._sessions], "this device's sign-ins are gone from the server")
        self.assertFalse([s for s in auth_manager._sessions.values() if s.get("remember") in mine])

    def test_signing_in_again_replaces_the_old_remembered_sign_in(self):
        old = row_id(self.device, "ana")
        sign_in(self.device, "ana")
        self.assertNotIn(old, auth_manager._sessions, "the old remembered sign-in is gone")
        self.assertEqual([r["username"] for r in rows(self.device)], ["ben", "ana"], "one row per account, the new one last")

    def test_an_expired_remembered_sign_in_asks_for_the_password(self):
        for row in auth_manager._sessions.values():
            if row["username"] == "ana":
                row["expires_at"] = time.time() - 1
        self.assertTrue(on_device(self.device)["ana"]["expired"], "still listed, marked to sign in again")
        r = switch(self.device, "ana")
        self.assertEqual((r.status_code, r.json()["code"]), (401, "password_required"))
        self.assertEqual(who(self.device), "ben", "a refused switch leaves the open account open")
        sign_in(self.device, "ana")
        self.assertFalse(on_device(self.device)["ana"]["expired"])
        self.assertEqual(who(self.device), "ana")

    def test_an_open_session_ends_with_its_remembered_sign_in(self):
        for row in auth_manager._sessions.values():
            if row["username"] == "ben":
                row["expires_at"] = time.time() - 1
        self.assertIsNone(who(self.device), "the 7-day rule still holds for the open account")
        self.assertTrue(on_device(self.device)["ben"]["expired"])

    def test_the_two_step_code_still_applies_at_the_first_sign_in(self):
        import pyotp
        uri = auth_manager.start_totp_enrollment("cy")
        secret = pyotp.parse_uri(uri).secret
        self.assertTrue(auth_manager.confirm_totp_enrollment("cy", pyotp.TOTP(secret).now()))
        r = self.device.post("/api/auth/login", json={"username": "cy", "password": PASSWORDS["cy"]})
        self.assertEqual(r.status_code, 401, "no code, no sign-in")
        self.assertNotIn("cy", on_device(self.device))
        sign_in(self.device, "cy", totp_code=pyotp.TOTP(secret).now())
        self.assertEqual(switch(self.device, "ana").status_code, 200)
        self.assertEqual(switch(self.device, "cy").status_code, 200, "once signed in here, switching needs no code")

    def test_a_device_holds_at_most_nine_accounts(self):
        setup = device(); setup.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("ana"))
        for n in range(8):
            PASSWORDS[f"u{n}"] = f"user-password-{n}"
            setup.post("/api/auth/users", json={"username": f"u{n}", "password": PASSWORDS[f"u{n}"]})
        for n in range(7):
            sign_in(self.device, f"u{n}")
        self.assertEqual(len(on_device(self.device)), 9)
        r = self.device.post("/api/auth/login", json={"username": "u7", "password": PASSWORDS["u7"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Sign out of one first", r.json()["detail"])

    def test_a_session_from_before_the_switcher_joins_it(self):
        legacy = device(); legacy.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("cy"))
        self.assertEqual(set(on_device(legacy)), {"cy"}, "the open account is adopted onto the switcher")
        sign_in(legacy, "ana")
        self.assertEqual(set(on_device(legacy)), {"cy", "ana"})
        self.assertEqual(switch(legacy, "cy").status_code, 200)

    def test_with_accounts_off_there_is_no_switcher(self):
        with patch.object(auth_routes, "auth_enabled", return_value=False):
            body = self.device.get("/api/auth/device-accounts").json()
            self.assertEqual((body["enabled"], body["accounts"]), (False, []))
            self.assertEqual(switch(self.device, "ana").status_code, 400)


class Csrf(SwitcherBase):
    def test_the_switch_route_refuses_another_site(self):
        for headers in ({}, {"X-Kairos-Switch": "1", "Origin": "https://evil.example"},
                        {"X-Kairos-Switch": "1", "Sec-Fetch-Site": "cross-site"},
                        {"X-Kairos-Switch": "1", "Sec-Fetch-Site": "same-site"}):
            r = self.device.post("/api/auth/switch", json={"username": "ana"}, headers=headers)
            self.assertEqual(r.status_code, 403, headers)
            self.assertEqual(who(self.device), "ben", "nothing switched")
        ok = self.device.post("/api/auth/switch", json={"username": "ana"},
                              headers={**APP, "Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(ok.status_code, 200, "the app's own page is let through")

    def test_the_other_switcher_routes_refuse_another_site(self):
        for method, path, body in (("post", "/api/auth/sign-out-account", {"username": "ana"}),
                                   ("post", "/api/auth/logout-all", None),
                                   ("put", "/api/auth/account/color", {"color": "plum"}),
                                   ("put", "/api/auth/account/switch-pin", {"password": PASSWORDS["ben"], "pin": "1234"})):
            r = getattr(self.device, method)(path, json=body)
            self.assertEqual(r.status_code, 403, path)
        self.assertEqual(set(on_device(self.device)), {"ana", "ben"})
        self.assertFalse(auth_manager.has_switch_pin("ben"))


class Pin(SwitcherBase):
    def setUp(self):
        super().setUp()
        switch(self.device, "ana")
        put = lambda body: self.device.put("/api/auth/account/switch-pin", json=body, headers=APP)
        self.assertEqual(put({"password": "wrong", "pin": "4321"}).status_code, 401, "the password is asked to set it")
        self.assertEqual(put({"password": PASSWORDS["ana"], "pin": "12"}).status_code, 400)
        self.assertEqual(put({"password": PASSWORDS["ana"], "pin": "12ab"}).status_code, 400)
        self.assertEqual(put({"password": PASSWORDS["ana"], "pin": "4321"}).json()["switch_pin"], True)
        self.assertTrue(on_device(self.device)["ana"]["pin"])
        switch(self.device, "ben")
        self.clock = time.time()
        patcher = patch.object(auth_module, "time", type("Clock", (), {"time": staticmethod(lambda: self.clock)}))
        patcher.start(); self.addCleanup(patcher.stop)

    def test_switching_in_asks_the_pin(self):
        r = switch(self.device, "ana")
        self.assertEqual((r.status_code, r.json()["code"]), (403, "pin_required"))
        self.assertEqual(who(self.device), "ben")
        self.assertEqual(switch(self.device, "ana", pin="4321").status_code, 200)
        self.assertEqual(who(self.device), "ana")
        self.assertEqual(switch(self.device, "ben").status_code, 200, "an account with no PIN asks none")

    def test_wrong_tries_lock_then_need_the_password(self):
        lefts = [switch(self.device, "ana", pin="0000").json().get("tries_left") for _ in range(4)]
        self.assertEqual(lefts, [4, 3, 2, 1])
        r = switch(self.device, "ana", pin="0000")
        self.assertEqual((r.status_code, r.json()["code"], r.json()["retry_after"]), (429, "pin_locked", 60))
        r = switch(self.device, "ana", pin="4321")
        self.assertEqual(r.status_code, 429, "while locked even the right PIN is not checked")
        self.assertEqual(who(self.device), "ben")
        self.clock += 61
        for _ in range(4):
            switch(self.device, "ana", pin="0000")
        r = switch(self.device, "ana", pin="0000")
        self.assertEqual(r.json()["code"], "password_required", "ten wrong in a row: the device forgets the account")
        self.assertNotIn("ana", on_device(self.device))
        self.assertEqual(switch(self.device, "ana", pin="4321").status_code, 404)
        sign_in(self.device, "ana")
        self.assertEqual(who(self.device), "ana", "the password still works")

    def test_a_right_pin_resets_the_count(self):
        for _ in range(5):
            switch(self.device, "ana", pin="0000")
        self.clock += 61
        self.assertEqual(switch(self.device, "ana", pin="4321").status_code, 200)
        self.assertNotIn("pin_failures", auth_manager._users["users"]["ana"])
        switch(self.device, "ben")
        lefts = [switch(self.device, "ana", pin="0000").json().get("tries_left") for _ in range(4)]
        self.assertEqual(lefts, [4, 3, 2, 1], "a fresh count after the right PIN")

    def test_clearing_the_pin(self):
        switch(self.device, "ana", pin="4321")
        r = self.device.put("/api/auth/account/switch-pin", json={"password": PASSWORDS["ana"], "pin": None}, headers=APP)
        self.assertEqual(r.json()["switch_pin"], False)
        switch(self.device, "ben")
        self.assertEqual(switch(self.device, "ana").status_code, 200)


class Colour(SwitcherBase):
    def test_accounts_get_distinct_colours_and_can_change_theirs(self):
        colours = [auth_manager.account_color(n) for n in ("ana", "ben", "cy")]
        self.assertEqual(len(set(colours)), 3)
        self.assertEqual(self.device.get("/api/auth/status").json()["color"], colours[1])
        r = self.device.put("/api/auth/account/color", json={"color": "plum"}, headers=APP)
        self.assertEqual(r.json(), {"ok": True, "color": "plum"})
        self.assertEqual(on_device(self.device)["ben"]["color"], "plum")
        self.assertEqual(self.device.put("/api/auth/account/color", json={"color": "#ff0000"}, headers=APP).status_code, 400)
        self.assertEqual(auth_manager.account_color("ana"), colours[0], "only one's own")


class Push(SwitcherBase):
    def test_a_push_for_an_account_reaches_the_device_only_while_it_is_open(self):
        switch(self.device, "ana")
        ana = row_id(self.device, "ana")
        binding = hashlib.sha256(ana.encode()).hexdigest()
        self.assertEqual(auth_manager.binding_token(self.device.cookies.get(SESSION_COOKIE_NAME)), ana)
        self.assertTrue(auth_manager.notification_session_valid("ana", binding))
        switch(self.device, "ben")
        self.assertFalse(auth_manager.notification_session_valid("ana", binding), "ben's open app gets none of ana's pushes")
        switch(self.device, "ana")
        self.assertTrue(auth_manager.notification_session_valid("ana", binding), "and ana's come back with her")


class LiveConnections(SwitcherBase):
    """A websocket (a realtime call) or a streamed response (the live chat feed) opened as one account ends when
    that session does: on a switch, a sign-out, sign out of all, or (on the periodic re-check) expiry."""

    @staticmethod
    def mini_app():
        import asyncio as aio
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from fastapi.responses import StreamingResponse
        app = FastAPI()

        @app.websocket("/ws")
        async def echo(socket: WebSocket):
            await socket.accept()
            try:
                while True:
                    await socket.send_text("as " + (await socket.receive_text()))
            except WebSocketDisconnect:
                pass

        @app.get("/stream")
        async def stream():
            async def lines():
                n = 0
                while True:
                    n += 1
                    yield f"line {n}\n"
                    await aio.sleep(0.05)
            return StreamingResponse(lines(), media_type="text/event-stream")

        app.add_middleware(middleware.AccountContextMiddleware)
        return app

    def socket_client(self):
        client = TestClient(self.mini_app())
        client.cookies.set(SESSION_COOKIE_NAME, self.device.cookies.get(SESSION_COOKIE_NAME))
        return client

    def assert_socket_closes(self, end_session):
        from starlette.websockets import WebSocketDisconnect
        with self.socket_client().websocket_connect("/ws") as socket:
            socket.send_text("hello")
            self.assertEqual(socket.receive_text(), "as hello")
            end_session()
            with self.assertRaises(WebSocketDisconnect) as closed:
                for _ in range(3):
                    socket.send_text("still there?")
                    socket.receive_text()
            self.assertEqual(closed.exception.code, 4401)

    def test_a_switch_closes_the_old_accounts_websocket(self):
        self.assert_socket_closes(lambda: self.assertEqual(switch(self.device, "ana").status_code, 200))

    def test_signing_out_closes_the_websocket(self):
        self.assert_socket_closes(lambda: self.device.post("/api/auth/sign-out-account", json={"username": "ben"}, headers=APP))

    def test_sign_out_of_all_closes_the_websocket(self):
        self.assert_socket_closes(lambda: self.device.post("/api/auth/logout-all", headers=APP))

    def test_an_expired_session_closes_the_websocket_on_the_recheck(self):
        def expire():
            for row in auth_manager._sessions.values():
                if row["username"] == "ben":
                    row["expires_at"] = time.time() - 1
        with patch.object(middleware, "SESSION_RECHECK_SECONDS", 0.1):
            self.assert_socket_closes(lambda: (expire(), time.sleep(0.4)))

    def test_a_switch_ends_the_old_accounts_stream(self):
        # Driven at the ASGI level: the test client would wait for an endless stream to finish before returning.
        import asyncio as aio
        token = self.device.cookies.get(SESSION_COOKIE_NAME)

        async def run():
            sent = []

            async def receive():
                await aio.sleep(3600)  # the browser never hangs up on its own
                return {"type": "http.disconnect"}

            async def send(message):
                sent.append(message)

            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
                     "path": "/stream", "raw_path": b"/stream", "query_string": b"", "root_path": "",
                     "headers": [(b"host", b"testserver"), (b"cookie", f"{SESSION_COOKIE_NAME}={token}".encode())],
                     "client": ("127.0.0.1", 5000), "server": ("testserver", 80)}
            stream = aio.ensure_future(self.mini_app()(scope, receive, send))
            await aio.sleep(0.3)
            self.assertFalse(stream.done(), "streaming while the session lives")
            self.assertEqual((await aio.to_thread(switch, self.device, "ana")).status_code, 200)
            at_switch = len(sent)
            await aio.wait_for(stream, 5)  # ends instead of running forever
            return sent, at_switch

        sent, at_switch = aio.run(run())
        self.assertGreater(at_switch, 2, "it was streaming")
        self.assertLessEqual(len(sent) - at_switch, 2, "nothing more of the old account is sent after the switch")

    def test_the_switch_reply_itself_still_arrives(self):
        r = switch(self.device, "ana")  # it ends the very session it came with
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["username"], "ana")

    def test_a_first_build_cookie_is_brought_onto_a_device(self):
        legacy = device()
        session = auth_manager.create_session("cy")
        remember = "L" * 43
        auth_manager._sessions[remember] = {"username": "ana", "expires_at": time.time() + 3600, "kind": "remember", "created_at": 1}
        legacy.cookies.set(SESSION_COOKIE_NAME, session)
        legacy.cookies.set(ACCOUNTS_COOKIE_NAME, remember)
        self.assertEqual(set(on_device(legacy)), {"cy", "ana"})
        self.assertTrue(legacy.cookies.get(DEVICE_COOKIE_NAME))
        self.assertEqual(switch(legacy, "ana").status_code, 200)
        self.assertEqual(who(legacy), "ana")


class NoDataFromTheOtherAccount(unittest.TestCase):
    """The leak test's seeding (13 stores, a model key among them) and its sweep of every GET route (the
    parameter-free ones and every one-id route with the other account's ids), on ONE device that switches."""

    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        cls.patcher = patch("services.email_service.email_service.send_message", return_value=None)
        cls.patcher.start()
        setup = device()
        assert setup.post("/api/auth/setup", json={"username": "ana", "password": PASSWORDS["ana"]}).status_code == 200
        assert setup.post("/api/auth/users", json={"username": "ben", "password": PASSWORDS["ben"]}).status_code == 200
        cls.device = device()
        sign_in(cls.device, "ana")
        sign_in(cls.device, "ben")
        cls.ana, cls.ben = Account("ana", cls.device), Account("ben", cls.device)
        assert switch(cls.device, "ana").status_code == 200
        fill(cls.ana)
        assert switch(cls.device, "ben").status_code == 200
        fill(cls.ben)
        cls.paths = kairos.app.openapi()["paths"]

    @classmethod
    def tearDownClass(cls):
        cls.patcher.stop()
        # Let the throwaway folder go (as the leak test does): the studio stores, the rooms database, the log files.
        from services.content_studio import close_all
        close_all()
        from core import bot_rooms_store
        bot_rooms_store.close()
        import logging
        for logger in [logging.getLogger()] + [logging.getLogger(n) for n in logging.root.manager.loggerDict]:
            for handler in list(getattr(logger, "handlers", [])):
                if isinstance(handler, logging.FileHandler):
                    handler.close(); logger.removeHandler(handler)

    def test_each_account_filled_its_own_stores(self):
        self.assertEqual(self.ana.seeded.get("notes"), "ok")
        self.assertEqual(self.ben.seeded.get("notes"), "ok")

    def test_while_ben_is_open_nothing_of_anas_is_served(self):
        assert switch(self.device, "ben").status_code == 200
        self.assertEqual(sorted(leaks_for(self.ben, self.ana, self.paths)), [])
        self.assertIn(self.ben.mark, self.device.get("/api/notes").text, "and ben sees his own")

    def test_after_switching_to_ana_nothing_of_bens_is_served(self):
        assert switch(self.device, "ana").status_code == 200
        self.assertEqual(sorted(leaks_for(self.ana, self.ben, self.paths)), [])
        self.assertIn(self.ana.mark, self.device.get("/api/notes").text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
