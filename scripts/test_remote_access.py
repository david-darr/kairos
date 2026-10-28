"""Remote Access (Tailscale): detection, refusals, TLS listener, routes, reconnect.

No real Tailscale, network or firewall is touched. The Tailscale command is
replaced with a recorded fake, the Windows firewall check is stubbed, and the
one real listener binds to loopback with a certificate generated here, so the
bind address, HTTPS, the login gate and stop/restart are exercised for real.
MANUAL (not covered): a real tailnet sign-in, a Tailscale-issued certificate,
another device reaching the URL, and the UAC prompt for the firewall rule.

    .venv\\Scripts\\python.exe scripts\\test_remote_access.py
"""
import asyncio
import datetime
import json
import logging
import os
import socket
import ssl
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tempfile

_DATA = tempfile.TemporaryDirectory(prefix="g7-remote-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

import httpx
from fastapi.testclient import TestClient

from app import app
from core import remote_access, settings as settings_store
from core.auth import SESSION_COOKIE_NAME, auth_manager

logging.disable(logging.CRITICAL)
HOST = "box.tail1234.ts.net"


def make_cert(directory: Path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOST)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=2)).sign(key, hashes.SHA256()))
    cert_path, key_path = directory / f"{HOST}.crt", directory / f"{HOST}.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
    return cert_path, key_path


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Fake:
    """Stands in for the tailscale command: records calls, answers from a table."""
    def __init__(self, status=None, cert_ok=True, cert_error=""):
        self.status, self.cert_ok, self.cert_error, self.calls = status, cert_ok, cert_error, []

    def __call__(self, args, timeout=15):
        self.calls.append(list(args))
        if args[:2] == ["status", "--json"]:
            if self.status is None:
                return subprocess.CompletedProcess(args, 1, "", "not running")
            return subprocess.CompletedProcess(args, 0, json.dumps(self.status), "")
        if args[0] == "cert":
            if self.cert_ok:
                Path(args[2]).write_text("CERT"); Path(args[4]).write_text("KEY")
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", self.cert_error)
        return subprocess.CompletedProcess(args, 1, "", "unknown")


def up(ip="100.64.0.7", state="Running", name=HOST + "."):
    return {"BackendState": state, "Self": {"TailscaleIPs": ["fd7a::7", ip], "DNSName": name}}


class RemoteAccess(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        self.certs = Path(_DATA.name) / f"certs-{self.id().split('.')[-1]}"
        self.certs.mkdir(exist_ok=True)
        for item in (patch.object(remote_access, "CERTS_DIR", str(self.certs)),
                     patch.object(remote_access, "firewall_rule_exists", return_value=True),
                     patch.object(remote_access, "tailscale_exe", return_value="tailscale-fake")):
            item.start(); self.addCleanup(item.stop)
        self.saved = {k: settings_store.get_setting(k) for k in ("remote_access_enabled", "remote_access_port")}
        settings_store.update_settings(remote_access_enabled=False, remote_access_port=free_port())
        self.addCleanup(lambda: settings_store.update_settings(**self.saved))
        self.addCleanup(lambda: asyncio.get_event_loop().run_until_complete(remote_access.stop()) if remote_access.is_running() else None)

    def fake(self, **kwargs):
        fake = Fake(**kwargs)
        patcher = patch.object(remote_access, "_run_tailscale", fake)
        patcher.start(); self.addCleanup(patcher.stop)
        return fake

    def admin(self):
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)

    # -- detection: tells the user exactly which step is missing -------------

    async def test_detect_names_each_missing_step(self):
        with patch.object(remote_access, "tailscale_exe", return_value=None):
            gone = remote_access.detect()
        self.assertEqual((gone["installed"], gone["running"], gone["logged_in"], gone["ip"]), (False, False, False, None))
        self.fake(status=None)
        self.assertEqual((remote_access.detect()["installed"], remote_access.detect()["running"]), (True, False))
        self.fake(status=up(state="NeedsLogin"))
        info = remote_access.detect()
        self.assertEqual((info["running"], info["logged_in"]), (True, False))
        self.fake(status=up())
        info = remote_access.detect()
        self.assertEqual((info["logged_in"], info["ip"], info["hostname"], info["has_cert"]), (True, "100.64.0.7", HOST, False),
                         "the IPv4 address is picked, the trailing dot is dropped")
        make_cert(self.certs)
        self.assertTrue(remote_access.detect()["has_cert"])
        self.assertFalse(remote_access.detect()["auth_ready"])
        self.admin()
        self.assertTrue(remote_access.detect()["auth_ready"])
        self.assertNotIn("key", json.dumps(remote_access.detect()).lower().replace("hostkey", ""), "status carries no key material")

    async def test_unreadable_status_is_a_clean_not_running(self):
        patcher = patch.object(remote_access, "_run_tailscale",
                               lambda args, timeout=15: subprocess.CompletedProcess(args, 0, "{not json", ""))
        patcher.start(); self.addCleanup(patcher.stop)
        self.assertFalse(remote_access.detect()["running"])

    # -- the hard gates: refused before any certificate or socket ------------

    async def test_start_refuses_each_unmet_condition_without_touching_a_socket(self):
        self.admin()
        with patch.object(remote_access, "tailscale_exe", return_value=None):
            self.assertIn("isn't installed", (await remote_access.start())["error"])
        self.fake(status=up(state="NeedsLogin"))
        self.assertIn("not signed in", (await remote_access.start())["error"])
        self.fake(status={"BackendState": "Running", "Self": {"TailscaleIPs": [], "DNSName": ""}})
        self.assertIn("Tailscale address", (await remote_access.start())["error"])
        auth_manager._users = {"users": {}}
        fake = self.fake(status=up())
        self.assertIn("Create an account first", (await remote_access.start())["error"])
        with patch.object(remote_access, "auth_enabled", return_value=False):
            auth_manager.create_user("late", "late-password-1")
            self.assertIn("Create an account first", (await remote_access.start())["error"], "an account with login enforcement off is still refused")
        self.assertEqual([c for c in fake.calls if c[0] == "cert"], [], "no certificate is requested before the login gate passes")
        self.assertFalse(remote_access.is_running())

    async def test_certificate_errors_say_what_to_do_and_a_pair_is_reused(self):
        self.admin()
        self.fake(status=up(), cert_ok=False, cert_error="HTTPS is not enabled for this tailnet")
        self.assertIn("login.tailscale.com/admin/dns", (await remote_access.start())["error"])
        self.fake(status=up(), cert_ok=False, cert_error="rate limited")
        self.assertEqual((await remote_access.start())["error"], "rate limited")
        good = self.fake(status=up(), cert_ok=True)
        self.assertEqual(remote_access.provision_cert(HOST)[2], None)
        remote_access.provision_cert(HOST)
        self.assertEqual(len([c for c in good.calls if c[0] == "cert"]), 1, "an existing pair is reused (Tailscale rate-limits issuance)")
        self.assertTrue(str(self.certs) in good.calls[-1][2], "certificates are written under the data folder, never the app folder")

    async def test_a_command_that_cannot_run_or_times_out_is_reported_not_raised(self):
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("tailscale", 1)):
            self.assertIsNone(remote_access._run_tailscale(["status", "--json"]))
        with patch("subprocess.run", side_effect=OSError("gone")):
            self.assertIsNone(remote_access._run_tailscale(["status", "--json"]))
        patcher = patch.object(remote_access, "_run_tailscale", lambda *a, **k: None)
        patcher.start(); self.addCleanup(patcher.stop)
        self.assertIn("Couldn't run", remote_access.provision_cert("nowhere.ts.net")[2])
        self.assertFalse(remote_access.detect()["running"])

    async def test_an_occupied_port_is_an_error_not_a_crash(self):
        self.admin()
        make_cert(self.certs)
        self.fake(status=up(ip="127.0.0.1"))
        holder = socket.socket(); holder.bind(("127.0.0.1", 0)); holder.listen(1); self.addCleanup(holder.close)
        settings_store.update_settings(remote_access_port=holder.getsockname()[1])
        result = await remote_access.start()
        self.assertFalse(result["ok"])
        self.assertIn("already in use", result["error"])
        self.assertFalse(remote_access.is_running())

    # -- the real listener: bind, TLS, login gate, stop, restart -------------

    async def start_loopback(self):
        self.admin()
        make_cert(self.certs)
        self.fake(status=up(ip="127.0.0.1"))
        result = await remote_access.start()
        self.assertTrue(result["ok"], result)
        return result

    def tls(self):
        return httpx.AsyncClient(verify=False, timeout=10)

    async def test_the_listener_is_https_login_gated_and_binds_only_the_tailnet_address(self):
        port = settings_store.get_setting("remote_access_port")
        result = await self.start_loopback()
        self.assertEqual(result["url"], f"https://{HOST}:{port}")
        self.assertTrue(remote_access.is_running())
        self.assertEqual((await remote_access.start())["url"], result["url"], "starting twice is a no-op")
        server = remote_access._server
        self.assertEqual((server.config.host, server.config.ssl_certfile is not None), ("127.0.0.1", True), "bound to the interface address, never 0.0.0.0")
        async with self.tls() as client:
            status = await client.get(f"https://127.0.0.1:{port}/api/auth/status")
            self.assertEqual(status.status_code, 200)
            self.assertTrue(status.json()["auth_enabled"])
            protected = await client.get(f"https://127.0.0.1:{port}/api/sessions")
            self.assertEqual(protected.status_code, 401, "a request over the network never gets the no-login local-user bypass")
            admin_only = await client.get(f"https://127.0.0.1:{port}/api/remote/status")
            self.assertIn(admin_only.status_code, (401, 403))
            self.assertEqual((await client.get(f"https://127.0.0.1:{port}/sw.js")).status_code, 200, "the phone app's worker is served")
            self.assertEqual((await client.get(f"https://127.0.0.1:{port}/static/manifest.webmanifest")).status_code, 200)
        with self.assertRaises(Exception):
            async with httpx.AsyncClient(timeout=3) as plain:
                await plain.get(f"http://127.0.0.1:{port}/api/auth/status")
        with socket.socket() as probe:
            probe.settimeout(1)
            self.assertNotEqual(probe.connect_ex(("127.0.0.2", port)), 0, "other local addresses are not listening")

    async def test_stop_frees_the_port_and_a_restart_reconnects_on_the_same_address(self):
        port = settings_store.get_setting("remote_access_port")
        first = await self.start_loopback()
        await remote_access.stop()
        self.assertFalse(remote_access.is_running())
        self.assertIsNone(remote_access._current_url)
        with socket.socket() as probe:
            self.assertTrue(remote_access._port_available("127.0.0.1", port)[0], "the port is free after stopping")
        # What a phone sees after the app restarts: same address, same login.
        settings_store.update_settings(remote_access_enabled=True)
        await remote_access.start_if_enabled()
        self.assertTrue(remote_access.is_running())
        self.assertEqual(remote_access._current_url, first["url"])
        session = auth_manager.create_session("boss")
        async with self.tls() as client:
            client.cookies.set(SESSION_COOKIE_NAME, session)
            self.assertEqual((await client.get(f"https://127.0.0.1:{port}/api/sessions")).status_code, 200, "the phone's existing login still works after a restart")
        await remote_access.stop()

    async def test_startup_never_fails_when_the_machine_left_the_tailnet(self):
        settings_store.update_settings(remote_access_enabled=True)
        self.fake(status=None)
        await remote_access.start_if_enabled()  # must not raise
        self.assertFalse(remote_access.is_running())
        settings_store.update_settings(remote_access_enabled=False)
        await remote_access.start_if_enabled()
        self.assertFalse(remote_access.is_running(), "a disabled setting starts nothing")

    # -- routes ----------------------------------------------------------------

    def clients(self):
        auth_manager.create_user("boss", "boss-password-1", is_admin=True) if not auth_manager.has_any_users() else None
        if "member" not in auth_manager._users["users"]:
            auth_manager.create_user("member", "member-password-1")
        out = {}
        for who in ("boss", "member"):
            c = TestClient(app); c.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session(who)); out[who] = c
        out["anon"] = TestClient(app)
        return out

    async def test_every_remote_route_is_admin_only(self):
        c = self.clients()
        for method, path in (("get", "/status"), ("get", "/download-url"), ("post", "/create-account"), ("post", "/port"),
                             ("post", "/enable"), ("post", "/firewall"), ("post", "/disable")):
            for who in ("member", "anon"):
                got = getattr(c[who], method)("/api/remote" + path, **({} if method == "get" else {"json": {}}))
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
        self.assertEqual(c["boss"].get("/api/remote/download-url").json()["url"], "https://tailscale.com/download")

    def boss_http(self):
        """Same event loop as the test, so the listener task the route starts stays alive."""
        self.clients()
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                                   cookies={SESSION_COOKIE_NAME: auth_manager.create_session("boss")})
        self.addAsyncCleanup(client.aclose)
        return client

    async def test_port_enable_and_disable_through_the_routes(self):
        c = self.boss_http()
        self.fake(status=up(ip="127.0.0.1"))
        make_cert(self.certs)
        for bad in (80, 1023, 65536, 0, None):
            self.assertEqual((await c.post("/api/remote/port", json={"port": bad})).status_code, 400, bad)
        port = free_port()
        self.assertEqual((await c.post("/api/remote/port", json={"port": port})).json(), {"ok": True, "port": port, "restarted": False})
        self.assertEqual(settings_store.get_setting("remote_access_port"), port, "the port persists on its own")
        enabled = await c.post("/api/remote/enable", json={})
        self.assertEqual(enabled.status_code, 200, enabled.text)
        self.assertEqual(enabled.json()["url"], f"https://{HOST}:{port}")
        self.assertTrue(settings_store.get_setting("remote_access_enabled"))
        live = (await c.get("/api/remote/status")).json()
        self.assertEqual((live["running_now"], live["url"]), (True, enabled.json()["url"]))
        moved = free_port()
        self.assertEqual((await c.post("/api/remote/port", json={"port": moved})).json()["restarted"], True, "a running listener moves to the new port")
        self.assertEqual((await c.get("/api/remote/status")).json()["url"], f"https://{HOST}:{moved}")
        self.assertTrue(remote_access._port_available("127.0.0.1", port)[0], "the old port was released by the move")
        self.assertEqual((await c.post("/api/remote/disable")).json(), {"ok": True})
        self.assertFalse(settings_store.get_setting("remote_access_enabled"))
        self.assertFalse(remote_access.is_running())

    async def test_a_failed_enable_leaves_the_setting_off_and_says_why(self):
        c = self.boss_http()
        self.fake(status=up(state="NeedsLogin"))
        failed = await c.post("/api/remote/enable", json={})
        self.assertEqual(failed.status_code, 400)
        self.assertIn("not signed in", failed.json()["detail"])
        self.assertFalse(settings_store.get_setting("remote_access_enabled"), "a failed enable must not persist 'on'")

    async def test_create_account_only_makes_the_first_login_and_never_resets_a_password(self):
        c = self.boss_http()
        hash_before = dict(auth_manager._users["users"]["boss"])
        with patch("routes.remote_routes.settings_store.update_settings") as update:
            with patch("routes.remote_routes.auth_enabled", return_value=True):
                signed_up_again = await c.post("/api/remote/create-account", json={"username": "z", "password": "longenough1"})
            self.assertEqual(signed_up_again.status_code, 400, "an account exists and login is on: sign in, do not sign up")
            with patch("routes.remote_routes.auth_enabled", return_value=False):
                switched = await c.post("/api/remote/create-account", json={"username": "", "password": ""})
            self.assertEqual(switched.json(), {"ok": True, "auth_enabled": True, "existing_account": True})
            update.assert_called_once_with(auth_enabled=True)
        self.assertEqual(auth_manager._users["users"]["boss"], hash_before, "the existing account and password were not touched")
        self.assertEqual(sorted(auth_manager._users["users"]), ["boss", "member"], "no account was created")
        # First account: a short password is refused and nothing is created.
        auth_manager._users = {"users": {}}
        with patch("routes.remote_routes.require_admin", return_value="local"), patch("core.middleware.auth_enabled", return_value=False):
            short = TestClient(app).post("/api/remote/create-account", json={"username": "first", "password": "short"})
        self.assertEqual(short.status_code, 400)
        self.assertFalse(auth_manager.has_any_users())


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        from core import session_manager_store
        session_manager_store.close()
