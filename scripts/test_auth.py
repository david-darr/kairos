"""Accounts (AUTH_ENABLED=true): first-run setup, login, logout, forgot/reset
password, TOTP, password change and admin user management, through the real
routes in routes/auth_routes.py. Runs against a throwaway data folder.

    .venv\\Scripts\\python.exe scripts\\test_auth.py
"""
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix=".tab-test-auth-", dir=str(Path(__file__).resolve().parent))
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

import pyotp
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import auth as auth_module
from core.auth import SESSION_COOKIE_NAME, auth_manager
from routes import auth_routes
from services.email_service import email_service

GENERIC = auth_routes._FORGOT_PASSWORD_GENERIC_RESPONSE


def make_client(address=("testclient", 50000)) -> TestClient:
    app = FastAPI()
    app.include_router(auth_routes.router)
    return TestClient(app, client=address)


class AuthTests(unittest.TestCase):
    def setUp(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager._resets = {}
        # Wrong sign-in tries are counted in memory per address and per name; each test starts with none.
        auth_routes._login_by_address.clear()
        auth_routes._login_by_username.clear()
        self.client = make_client()
        self.sent = []
        self.addCleanup(patch.stopall)
        patch.object(email_service, "list_accounts", return_value=[{"id": "acct1", "email": "me@example.com"}]).start()
        patch.object(email_service, "send_message", side_effect=lambda *a, **k: self.sent.append(k)).start()

    # -- helpers ----------------------------------------------------------
    def setup_admin(self, client=None, username="david", password="first-password"):
        response = (client or self.client).post("/api/auth/setup", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def login(self, username, password, totp_code=None, address=("testclient", 50000)):
        client = make_client(address)
        body = {"username": username, "password": password}
        if totp_code is not None:
            body["totp_code"] = totp_code
        return client, client.post("/api/auth/login", json=body)

    def add_member(self, username="member", password="member-password", is_admin=False):
        response = self.client.post("/api/auth/users", json={"username": username, "password": password, "is_admin": is_admin})
        self.assertEqual(response.status_code, 200, response.text)

    # -- first account ----------------------------------------------------
    def test_first_account_is_created_once_and_is_admin(self):
        status = self.client.get("/api/auth/status").json()
        self.assertTrue(status["setup_required"])
        self.assertIsNone(status["username"])
        created = self.setup_admin()
        self.assertEqual(created.json(), {"username": "david", "is_admin": True})
        self.assertTrue(self.client.cookies.get(SESSION_COOKIE_NAME), "setup signs the new admin in")
        status = self.client.get("/api/auth/status").json()
        self.assertEqual((status["setup_required"], status["username"], status["is_admin"]), (False, "david", True))
        again = make_client().post("/api/auth/setup", json={"username": "intruder", "password": "x" * 12})
        self.assertEqual(again.status_code, 400, "a second setup can never create another admin")
        self.assertEqual([u["username"] for u in auth_manager.list_users()], ["david"])

    # -- login / logout ---------------------------------------------------
    def test_login_rejects_bad_credentials_identically(self):
        self.setup_admin()
        _, wrong_password = self.login("david", "nope")
        _, unknown_user = self.login("nobody", "nope")
        self.assertEqual((wrong_password.status_code, unknown_user.status_code), (401, 401))
        self.assertEqual(wrong_password.json(), unknown_user.json(), "no username oracle")
        client, ok = self.login("david", "first-password")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(client.get("/api/auth/status").json()["username"], "david")

    # -- wrong sign-in tries are limited (2026-11-12) ------------------------
    def test_five_wrong_tries_from_one_address_lock_it_out_even_for_the_right_password(self):
        self.setup_admin()
        for _ in range(auth_routes.LOGIN_TRIES_PER_ADDRESS):
            self.assertEqual(self.login("david", "nope", address=("10.0.0.7", 1))[1].status_code, 401)
        locked = self.login("david", "first-password", address=("10.0.0.7", 1))[1]
        self.assertEqual((locked.status_code, locked.json()), (429, {"detail": auth_routes.LOGIN_LOCKED}))
        self.assertGreater(int(locked.headers["retry-after"]), 0)
        other_name = self.login("nobody", "nope", address=("10.0.0.7", 1))[1]
        self.assertEqual((other_name.status_code, other_name.json()), (429, {"detail": auth_routes.LOGIN_LOCKED}),
                         "the lock is on the address, whatever name it tries, and reads the same for a name that does not exist")
        self.assertEqual(self.login("david", "first-password", address=("10.0.0.8", 1))[1].status_code, 200, "another address still signs in")
        for _ in range(20):  # a locked address's tries are not looked at and do not count against the name
            self.login("david", "nope", address=("10.0.0.7", 1))
        self.assertEqual(self.login("david", "first-password", address=("10.0.0.9", 1))[1].status_code, 200)

    def test_the_lock_lifts_when_the_ten_minutes_pass(self):
        self.setup_admin()
        start = time.time()
        with patch("core.try_limits.time.time", return_value=start):
            for _ in range(auth_routes.LOGIN_TRIES_PER_ADDRESS):
                self.login("david", "nope", address=("10.0.1.1", 1))
            self.assertEqual(self.login("david", "first-password", address=("10.0.1.1", 1))[1].status_code, 429)
        with patch("core.try_limits.time.time", return_value=start + auth_routes.LOGIN_WINDOW_SECONDS - 5):
            self.assertEqual(self.login("david", "first-password", address=("10.0.1.1", 1))[1].status_code, 429)
        with patch("core.try_limits.time.time", return_value=start + auth_routes.LOGIN_WINDOW_SECONDS + 1):
            self.assertEqual(self.login("david", "first-password", address=("10.0.1.1", 1))[1].status_code, 200)

    def test_a_right_sign_in_does_not_wipe_the_count(self):
        self.setup_admin()
        self.add_member()
        for _ in range(auth_routes.LOGIN_TRIES_PER_ADDRESS - 1):
            self.assertEqual(self.login("david", "nope", address=("10.0.2.1", 1))[1].status_code, 401)
        self.assertEqual(self.login("member", "member-password", address=("10.0.2.1", 1))[1].status_code, 200,
                         "one's own account still signs in")
        self.assertEqual(self.login("david", "nope", address=("10.0.2.1", 1))[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", address=("10.0.2.1", 1))[1].status_code, 429,
                         "signing in to one's own account buys no more guesses at another")

    def test_many_addresses_cannot_share_out_one_accounts_guesses(self):
        self.setup_admin()
        self.add_member()
        for n in range(auth_routes.LOGIN_TRIES_PER_USERNAME):
            self.assertEqual(self.login("david", "nope", address=(f"10.0.3.{n + 1}", 1))[1].status_code, 401)
        locked = self.login("david", "first-password", address=("10.0.3.200", 1))[1]
        self.assertEqual((locked.status_code, locked.json()), (429, {"detail": auth_routes.LOGIN_LOCKED}))
        self.assertEqual(self.login("member", "member-password", address=("10.0.3.200", 1))[1].status_code, 200, "only that name is held")
        for local in ("127.0.0.1", "::1"):
            self.assertEqual(self.login("david", "first-password", address=(local, 1))[1].status_code, 200,
                             "the owner at this computer is never locked out by tries from the network")

    def test_this_computer_is_still_held_to_the_per_address_count(self):
        self.setup_admin()
        for _ in range(auth_routes.LOGIN_TRIES_PER_ADDRESS):
            self.assertEqual(self.login("david", "nope", address=("127.0.0.1", 1))[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", address=("127.0.0.1", 1))[1].status_code, 429)

    def test_a_wrong_two_step_code_counts_and_a_missing_one_does_not(self):
        self.setup_admin()
        totp = self.enroll(self.client)
        self.client.post("/api/auth/totp/confirm", json={"code": totp.now()})
        wrong = "123456" if totp.now() != "123456" else "654321"
        for _ in range(8):  # the sign-in page sends the password alone first, every time
            self.assertEqual(self.login("david", "first-password", address=("10.0.4.1", 1))[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", totp.now(), address=("10.0.4.1", 1))[1].status_code, 200)
        for _ in range(auth_routes.LOGIN_TRIES_PER_ADDRESS):
            self.assertEqual(self.login("david", "first-password", wrong, address=("10.0.4.1", 1))[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", totp.now(), address=("10.0.4.1", 1))[1].status_code, 429)

    def test_an_unknown_name_costs_a_password_check_like_a_known_one(self):
        self.setup_admin()
        with patch.object(auth_module.bcrypt, "checkpw", wraps=auth_module.bcrypt.checkpw) as checked:
            self.login("nobody", "nope", address=("10.0.5.1", 1))
            self.login("david", "nope", address=("10.0.5.2", 1))
        self.assertEqual(checked.call_count, 2, "no faster answer for a name that does not exist")

    def test_logout_ends_the_session_for_good(self):
        self.setup_admin()
        client, _ = self.login("david", "first-password")
        token = client.cookies.get(SESSION_COOKIE_NAME)
        self.assertEqual(client.get("/api/auth/users").status_code, 200)
        self.assertEqual(client.post("/api/auth/logout").json(), {"ok": True, "remaining": []}, "no other account was signed in here")
        replay = make_client()
        replay.cookies.set(SESSION_COOKIE_NAME, token)
        self.assertEqual(replay.get("/api/auth/users").status_code, 401, "the old cookie no longer works")

    def test_expired_session_stops_working(self):
        self.setup_admin()
        token = self.client.cookies.get(SESSION_COOKIE_NAME)
        auth_manager._sessions[token]["expires_at"] = time.time() - 1
        self.assertEqual(self.client.get("/api/auth/users").status_code, 401)
        self.assertNotIn(token, auth_manager._sessions)

    # -- forgot / reset password -------------------------------------------
    def test_forgot_password_never_reveals_which_part_was_wrong(self):
        self.setup_admin()
        for username, email in [("nobody", "me@example.com"), ("david", "other@example.com"), ("david", "ME@example.com ")]:
            with self.subTest(username=username, email=email):
                response = self.client.post("/api/auth/forgot-password", json={"username": username, "email": email})
                self.assertEqual((response.status_code, response.json()), (200, GENERIC))
        self.assertEqual(len(self.sent), 1, "only the matching username + configured email sends a code")
        self.assertEqual(self.sent[0]["to"], "me@example.com")

    def test_reset_code_works_once_and_drops_old_sessions(self):
        self.setup_admin()
        old_client, _ = self.login("david", "first-password")
        self.client.post("/api/auth/forgot-password", json={"username": "david", "email": "me@example.com"})
        code = self.sent[0]["body"].split("code is: ")[1][:6]
        short = self.client.post("/api/auth/reset-password", json={"username": "david", "code": code, "new_password": "short"})
        self.assertEqual(short.status_code, 400)
        ok = self.client.post("/api/auth/reset-password", json={"username": "david", "code": code, "new_password": "brand-new-password"})
        self.assertEqual(ok.json(), {"ok": True})
        self.assertEqual(old_client.get("/api/auth/users").status_code, 401, "a reset signs out every old session")
        reuse = self.client.post("/api/auth/reset-password", json={"username": "david", "code": code, "new_password": "another-password"})
        self.assertEqual(reuse.status_code, 400, "the code is single use")
        self.assertEqual(self.login("david", "first-password")[1].status_code, 401)
        self.assertEqual(self.login("david", "brand-new-password")[1].status_code, 200)

    def test_reset_code_guessing_is_capped_and_codes_expire(self):
        self.setup_admin()
        self.client.post("/api/auth/forgot-password", json={"username": "david", "email": "me@example.com"})
        code = self.sent[0]["body"].split("code is: ")[1][:6]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(auth_module.RESET_MAX_ATTEMPTS):
            self.client.post("/api/auth/reset-password", json={"username": "david", "code": wrong, "new_password": "guess-password"})
        late = self.client.post("/api/auth/reset-password", json={"username": "david", "code": code, "new_password": "right-but-late"})
        self.assertEqual(late.status_code, 400, "after the attempt budget even the right code fails")
        self.assertEqual(self.login("david", "first-password")[1].status_code, 200)
        # A fresh code after the cooldown, then let it expire.
        auth_manager._resets.clear()
        self.client.post("/api/auth/forgot-password", json={"username": "david", "email": "me@example.com"})
        code = self.sent[-1]["body"].split("code is: ")[1][:6]
        auth_manager._resets["david"]["expires_at"] = time.time() - 1
        expired = self.client.post("/api/auth/reset-password", json={"username": "david", "code": code, "new_password": "too-late-password"})
        self.assertEqual(expired.status_code, 400)

    def test_reset_requests_are_rate_limited(self):
        self.setup_admin()
        for _ in range(3):
            self.client.post("/api/auth/forgot-password", json={"username": "david", "email": "me@example.com"})
        self.assertEqual(len(self.sent), 1, "repeat requests inside the cooldown send nothing")

    # -- TOTP -------------------------------------------------------------
    def enroll(self, client):
        uri = client.post("/api/auth/totp/enroll").json()["provisioning_uri"]
        return pyotp.TOTP(parse_qs(urlparse(uri).query)["secret"][0])

    def test_totp_enrollment_then_login_needs_the_code(self):
        self.setup_admin()
        totp = self.enroll(self.client)
        self.assertEqual(self.client.post("/api/auth/totp/confirm", json={"code": "000000" if totp.now() != "000000" else "111111"}).status_code, 400)
        self.assertFalse(auth_manager.totp_enabled("david"), "a wrong code does not turn 2FA on")
        self.assertEqual(self.client.post("/api/auth/totp/confirm", json={"code": totp.now()}).json(), {"ok": True})
        self.assertEqual(self.login("david", "first-password")[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", "123456" if totp.now() != "123456" else "654321")[1].status_code, 401)
        self.assertEqual(self.login("david", "first-password", totp.now())[1].status_code, 200)
        self.assertEqual(self.client.post("/api/auth/totp/disable").json(), {"ok": True})
        self.assertEqual(self.login("david", "first-password")[1].status_code, 200)

    def test_starting_a_new_enrollment_does_not_break_the_active_authenticator(self):
        self.setup_admin()
        active = self.enroll(self.client)
        self.client.post("/api/auth/totp/confirm", json={"code": active.now()})
        self.enroll(self.client)  # started, never confirmed
        self.assertEqual(self.login("david", "first-password", active.now())[1].status_code, 200,
                         "an unconfirmed enrollment must not replace the authenticator already in use")

    def test_enrollment_started_before_pending_secrets_still_confirms(self):
        self.setup_admin()
        legacy = pyotp.random_base32()
        auth_manager._users["users"]["david"].update(totp_secret=legacy, totp_enabled=False)
        self.assertEqual(self.client.post("/api/auth/totp/confirm", json={"code": pyotp.TOTP(legacy).now()}).json(), {"ok": True})
        self.assertEqual(self.login("david", "first-password", pyotp.TOTP(legacy).now())[1].status_code, 200)
        self.client.post("/api/auth/totp/disable")
        self.assertNotIn("totp_pending_secret", auth_manager._users["users"]["david"])

    def test_totp_routes_need_a_signed_in_user(self):
        for path in ("/api/auth/totp/enroll", "/api/auth/totp/disable"):
            self.assertEqual(make_client().post(path).status_code, 401)
        self.assertEqual(make_client().post("/api/auth/totp/confirm", json={"code": "123456"}).status_code, 401)

    # -- password change ---------------------------------------------------
    def test_password_change_needs_the_current_password(self):
        self.setup_admin()
        wrong = self.client.post("/api/auth/password", json={"current_password": "guess", "new_password": "next-password"})
        self.assertEqual(wrong.status_code, 401)
        ok = self.client.post("/api/auth/password", json={"current_password": "first-password", "new_password": "next-password"})
        self.assertEqual(ok.json(), {"ok": True})
        self.assertEqual(self.login("david", "first-password")[1].status_code, 401)
        self.assertEqual(self.login("david", "next-password")[1].status_code, 200)
        self.assertEqual(make_client().post("/api/auth/password", json={"current_password": "x", "new_password": "y"}).status_code, 401)

    # -- admin user management ---------------------------------------------
    def test_members_cannot_manage_users(self):
        self.setup_admin()
        self.add_member()
        member, _ = self.login("member", "member-password")
        for method, path, body in [("GET", "/api/auth/users", None),
                                   ("POST", "/api/auth/users", {"username": "x", "password": "x-password"}),
                                   ("POST", "/api/auth/users/member/admin", {"is_admin": True}),
                                   ("DELETE", "/api/auth/users/david", None)]:
            with self.subTest(method=method, path=path):
                self.assertEqual(member.request(method, path, json=body).status_code, 403)
                self.assertEqual(make_client().request(method, path, json=body).status_code, 401)
        self.assertFalse(auth_manager.is_admin("member"))
        self.assertIn("david", [u["username"] for u in auth_manager.list_users()])

    def test_admin_user_management_keeps_an_admin_and_reserved_names(self):
        self.setup_admin()
        for name in ("internal-tool", "api", "david"):
            with self.subTest(name=name):
                bad = self.client.post("/api/auth/users", json={"username": name, "password": "some-password"})
                self.assertEqual(bad.status_code, 400)
        self.add_member()
        self.assertEqual(self.client.post("/api/auth/users/david/admin", json={"is_admin": False}).status_code, 400,
                         "the last admin cannot be demoted")
        self.assertEqual(self.client.delete("/api/auth/users/david").status_code, 400, "no deleting yourself")
        self.assertEqual(self.client.post("/api/auth/users/ghost/admin", json={"is_admin": True}).status_code, 404)
        self.assertEqual(self.client.delete("/api/auth/users/ghost").status_code, 404)
        member, _ = self.login("member", "member-password")
        self.assertEqual(self.client.post("/api/auth/users/member/admin", json={"is_admin": True}).json(), {"ok": True})
        self.assertEqual(member.get("/api/auth/users").status_code, 200, "promotion takes effect on the live session")
        self.assertEqual(self.client.post("/api/auth/users/member/admin", json={"is_admin": False}).json(), {"ok": True})
        self.assertEqual(member.get("/api/auth/users").status_code, 403, "and so does demotion")
        self.assertEqual(self.client.delete("/api/auth/users/member").json(), {"ok": True})
        self.assertEqual(member.get("/api/auth/status").json()["username"], None, "a deleted account's cookie stops working")
        self.assertEqual(self.login("member", "member-password")[1].status_code, 401)

    def test_status_reports_other_accounts_without_listing_them(self):
        self.setup_admin()
        self.assertFalse(self.client.get("/api/auth/status").json()["other_users_exist"])
        self.add_member()
        status = make_client().get("/api/auth/status").json()
        self.assertTrue(status["other_users_exist"])
        self.assertNotIn("member", str(status), "anonymous status never names accounts")


if __name__ == "__main__":
    unittest.main()
