"""A21 (Part 2, g8): the route map's auth sweep and the admin routes that had no HTTP test.

1. Every route in app.openapi() is hit anonymously with auth on; each must be
   refused (401/403) unless it is one of the documented public routes.
2. A member (non-admin) is refused on every A21 admin route.
3. HTTP-level behaviour of file checkpoints, backup/restore, import, wipe,
   logs (filters + redaction), sandbox changes, workspace browse/vet.

Throwaway data folder only.   .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g8_operations_routes.py
"""
import io
import os
import re
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tab_test_support import TemporaryDirectory

_DATA = TemporaryDirectory(prefix=".tab-test-g8ops-", dir=str(ROOT / "scripts"))
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = os.path.join(_DATA.name, "vault")
os.environ["AUTH_ENABLED"] = "true"

from unittest.mock import patch  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from core import file_checkpoints as cp  # noqa: E402
from core.auth import SESSION_COOKIE_NAME, auth_manager  # noqa: E402

# Routes that answer without a session on purpose (static shell, health probe, login flow).
PUBLIC_PREFIXES = ("/api/auth/",)
PUBLIC_EXACT = {"/", "/sw.js", "/api/health", "/usage-overlay"}
PUBLIC_PATTERNS = (r"^/custom-views/", r"^/tab-files/")
# Reachable without a session on purpose (checked in the source 2026-10-27).
BY_DESIGN = {
    "/api/integrations/oauth/callback": "browser redirect from the provider; state-checked, 400 without it",
    "/api/google/oauth/callback": "browser redirect from Google; state-checked, 400 without it",
    "/api/designs/{design_id}/assets/{name}": "content-addressed and immutable; a sandboxed board frame sends no session",
    "/api/designs/{design_id}/boards/{slug}/assets/{name}": "same",
    "/api/design-fonts/{system_id}/{file}": "font files for sandboxed board frames",
    "/api/design-looks/{system_id}/preview": "a bundled look's script-free preview for a sandboxed Tool Store frame",
    "/api/design-render/jobs": "Electron render worker; _worker() checks its own credential",
    "/api/design-render/result/{job_id}": "same",
    "/api/cli/local-path": "paired Kairos CLI on loopback; checks inside the handler (422 here is body validation first)",
}
# Add-on gate runs as a router dependency BEFORE the auth dependency, so an
# anonymous caller gets 409 (add-on off) instead of 401. Nothing is executed;
# logged as a low-severity ordering finding (see the g8 report).
ADDON_GATE_FIRST = {"/api/creative/blender", "/api/creative/blender/addon", "/api/creative/higgsfield/sign-in",
                    "/api/creative/oauth/callback", "/api/creative/higgsfield/review"}


def all_routes():
    return [(m.upper(), p) for p, item in app.openapi()["paths"].items() for m in item
            if m in ("get", "post", "put", "delete", "patch")]


def fill(path):
    return re.sub(r"\{[^}]+\}", "probe", path)


A21_ADMIN = [
    ("GET", "/api/system/diagnostics"), ("GET", "/api/system/logs/files"), ("GET", "/api/system/logs"),
    ("GET", "/api/system/backup/full"), ("GET", "/api/system/backup/export"), ("POST", "/api/system/backup/import"),
    ("GET", "/api/system/backup/restore"), ("POST", "/api/system/backup/restore"), ("DELETE", "/api/system/backup/restore"),
    ("POST", "/api/system/wipe"), ("GET", "/api/system/wipe-kinds"),
    ("GET", "/api/file-checkpoints"), ("GET", "/api/file-checkpoints/probe"), ("POST", "/api/file-checkpoints/probe/restore"),
    ("GET", "/api/sandbox/changes"), ("GET", "/api/sandbox/changes/probe"),
    ("POST", "/api/sandbox/changes/probe/apply"), ("DELETE", "/api/sandbox/changes/probe"),
    ("GET", "/api/workspace/browse"), ("GET", "/api/workspace/vet"), ("GET", "/api/computer/status"),
]


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password", is_admin=True)
        auth_manager.create_user("member", "member-password")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))


class RouteSweepTests(Base):
    def test_the_route_list_is_enumerable(self):
        routes = all_routes()
        self.assertGreater(len(routes), 450, "the openapi schema lost routes")
        self.assertEqual(len(routes), len(set(routes)))

    def test_every_route_refuses_an_anonymous_caller_unless_public(self):
        # Each request runs on a thread with a timeout so a route that wrongly
        # streams to an anonymous caller fails instead of hanging the suite.
        open_routes, hung = [], []
        for method, path in all_routes():
            public = (path in PUBLIC_EXACT or path.startswith(PUBLIC_PREFIXES)
                      or any(re.match(p, path) for p in PUBLIC_PATTERNS))
            if public or path in BY_DESIGN:
                continue
            box = {}

            def go():
                try:
                    kwargs = {} if method in ("GET", "DELETE") else {"json": {}}
                    box["code"] = self.anon.request(method, fill(path), **kwargs).status_code
                except Exception as exc:  # a crash is also not a refusal
                    box["code"] = "exception " + type(exc).__name__
            worker = threading.Thread(target=go, daemon=True)
            worker.start()
            worker.join(10)
            if worker.is_alive():
                hung.append((method, path))
            elif box.get("code") not in (401, 403) and not (path == "/api/creative/oauth/callback" and box.get("code") == 409):
                open_routes.append((method, path, box.get("code")))
        self.assertEqual(hung, [], "routes that never answered an anonymous caller")
        self.assertEqual(open_routes, [], "non-public routes an anonymous caller was not refused on")

    def test_members_are_refused_on_every_a21_admin_route(self):
        for method, path in A21_ADMIN:
            with self.subTest(method=method, path=path):
                kwargs = {} if method in ("GET", "DELETE") else {"json": {}}
                self.assertIn(self.member.request(method, path, **kwargs).status_code, (401, 403))

    def test_the_a21_admin_routes_exist(self):
        templated = {(m, fill(p)) for m, p in all_routes()}
        for item in A21_ADMIN:
            self.assertIn(item, templated)


class CheckpointRouteTests(Base):
    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="g8-cp-", dir=_DATA.name))
        self.vault, self.repo, self.work = base / "vault", base / "source", base / "work"
        for folder in (self.vault, self.repo, self.work):
            folder.mkdir()
        (self.repo / ".git").write_text("marker")
        for item in (patch.object(cp, "STORE", base / "archive"), patch.object(cp, "BASE_DIR", str(self.repo)),
                     patch.object(cp, "resolve_vault_dir", return_value=str(self.vault))):
            item.start()
            self.addCleanup(item.stop)

    def record(self):
        import asyncio
        (self.work / "a.txt").write_text("one\n")

        async def turn():
            async with cp.around_turn("chat:g8", str(self.work)):
                (self.work / "a.txt").write_text("two\n")
                (self.work / "new.txt").write_text("fresh\n")
        asyncio.run(turn())
        return cp.list_events()[0]

    def test_list_open_restore_and_stale_edit_conflict(self):
        event = self.record()
        listed = self.admin.get("/api/file-checkpoints").json()
        self.assertEqual([e["id"] for e in listed], [event["id"]])
        full = self.admin.get("/api/file-checkpoints/" + event["id"]).json()
        work_root = next(r for r in full["roots"] if r["path"] == str(self.work))
        paths = {c["path"] for c in work_root["changes"]}
        self.assertEqual(paths, {"a.txt", "new.txt"})
        # a later edit by someone else: the whole selection is refused, nothing restored
        (self.work / "a.txt").write_text("edited later\n")
        pick = [{"root": str(self.work), "path": p} for p in sorted(paths)]
        stale = self.admin.post("/api/file-checkpoints/%s/restore" % event["id"], json={"files": pick})
        self.assertEqual(stale.status_code, 409)
        self.assertIn("Nothing was restored", stale.json()["detail"])
        self.assertEqual((self.work / "a.txt").read_text(), "edited later\n")
        self.assertTrue((self.work / "new.txt").exists())
        # the untouched file alone restores cleanly (added file is removed)
        ok = self.admin.post("/api/file-checkpoints/%s/restore" % event["id"],
                             json={"files": [{"root": str(self.work), "path": "new.txt"}]})
        self.assertEqual(ok.status_code, 200)
        self.assertFalse((self.work / "new.txt").exists())
        self.assertEqual((self.work / "a.txt").read_text(), "edited later\n")

    def test_unknown_id_and_malformed_body(self):
        self.assertEqual(self.admin.get("/api/file-checkpoints/does-not-exist").status_code, 404)
        self.assertEqual(self.admin.post("/api/file-checkpoints/does-not-exist/restore",
                                         json={"files": []}).status_code, 404)
        self.assertEqual(self.admin.post("/api/file-checkpoints/x/restore", json={"files": "nope"}).status_code, 422)
        self.assertEqual(self.admin.post("/api/file-checkpoints/x/restore", json={}).status_code, 422)

    def test_a_path_escaping_the_root_is_not_restored(self):
        event = self.record()
        outside = Path(self.work).parent / "outside.txt"
        outside.write_text("keep\n")
        response = self.admin.post("/api/file-checkpoints/%s/restore" % event["id"],
                                   json={"files": [{"root": str(self.work), "path": "../outside.txt"}]})
        self.assertGreaterEqual(response.status_code, 400)
        self.assertEqual(outside.read_text(), "keep\n")


def make_zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class BackupRouteTests(Base):
    def test_a_full_backup_is_a_zip_without_keys_unless_asked(self):
        plain = self.admin.get("/api/system/backup/full")
        self.assertEqual(plain.status_code, 200)
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(plain.content)))
        self.assertNotIn("with-keys", plain.headers.get("content-disposition", ""))
        keyed = self.admin.get("/api/system/backup/full?include_keys=true")
        self.assertIn("with-keys", keyed.headers.get("content-disposition", ""))

    def test_bad_archives_are_refused_and_nothing_is_staged(self):
        for name, blob in (("junk.zip", b"not a zip at all"), ("empty.zip", make_zip({})),
                           ("traversal.zip", make_zip({"../evil.txt": b"x", "manifest.json": b"{}"}))):
            with self.subTest(name=name):
                response = self.admin.post("/api/system/backup/restore", files={"file": (name, blob)})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("Not restored", response.json()["detail"])
        self.assertIsNone(self.admin.get("/api/system/backup/restore").json()["pending"])

    def test_a_real_backup_stages_and_can_be_cancelled(self):
        blob = self.admin.get("/api/system/backup/full").content
        staged = self.admin.post("/api/system/backup/restore", files={"file": ("b.zip", blob)})
        self.assertEqual(staged.status_code, 200, staged.text)
        self.assertTrue(self.admin.get("/api/system/backup/restore").json()["pending"])
        self.assertTrue(self.admin.delete("/api/system/backup/restore").json()["ok"])
        self.assertIsNone(self.admin.get("/api/system/backup/restore").json()["pending"])
        self.assertFalse(self.admin.delete("/api/system/backup/restore").json()["ok"])

    def test_import_rejects_unrecognised_json_and_export_keeps_passwords_out(self):
        self.assertEqual(self.admin.post("/api/system/backup/import", json={"data": {}}).status_code, 400)
        self.assertEqual(self.admin.post("/api/system/backup/import", json={"data": "x"}).status_code, 422)
        exported = self.admin.get("/api/system/backup/export").json()
        self.assertIn("version", exported)
        self.assertNotIn("boss-password", str(exported))

    def test_wipe_accepts_only_known_kinds(self):
        kinds = self.admin.get("/api/system/wipe-kinds").json()
        self.assertEqual(kinds, sorted(kinds))
        for bad in ("everything", "../vault", "", "CHATS"):
            self.assertEqual(self.admin.post("/api/system/wipe", json={"kind": bad}).status_code, 400, bad)
        self.assertEqual(self.admin.post("/api/system/wipe", json={}).status_code, 422)


class LogRouteTests(Base):
    def test_listing_validation_and_secret_redaction_over_http(self):
        import logging
        from core import logs as log_files
        secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234567890"
        line = log_files.redact("calling https://example.com/x?api_key=hunter2hunter2&ok=1 with " + secret)
        self.assertNotIn("hunter2hunter2", line)
        self.assertIn("api_key=***", line)
        self.assertIsInstance(self.admin.get("/api/system/logs/files").json(), list)
        self.assertEqual(self.admin.get("/api/system/logs?name=../../etc/passwd").status_code, 400)
        self.assertEqual(self.admin.get("/api/system/logs?limit=0").status_code, 422)
        self.assertEqual(self.admin.get("/api/system/logs?limit=5000").status_code, 422)
        self.assertEqual(self.admin.get("/api/system/logs?text=" + "x" * 201).status_code, 422)
        del logging


class LogRedactionGapTests(unittest.TestCase):
    def test_BUG_a_bare_provider_key_in_a_log_line_is_masked(self):
        # core/logs.py masks bot tokens, ?key= style params and Bearer values only.
        from core import logs as log_files
        secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234567890"
        self.assertNotIn(secret, log_files.redact("provider said bad key " + secret))


class SandboxAndWorkspaceRouteTests(Base):
    def test_unknown_change_sets_are_404(self):
        self.assertEqual(self.admin.get("/api/sandbox/changes").json(), [])
        for method, path in (("GET", "/api/sandbox/changes/nope"), ("POST", "/api/sandbox/changes/nope/apply"),
                             ("DELETE", "/api/sandbox/changes/nope")):
            self.assertEqual(self.admin.request(method, path).status_code, 404, (method, path))

    def test_workspace_vet_and_browse(self):
        folder = Path(tempfile.mkdtemp(prefix="g8-ws-", dir=_DATA.name))
        (folder / "child").mkdir()
        vet = self.admin.get("/api/workspace/vet", params={"path": str(folder)}).json()
        self.assertTrue(vet["ok"])
        bad = self.admin.get("/api/workspace/vet", params={"path": str(folder / "missing")}).json()
        self.assertFalse(bad["ok"])
        listing = self.admin.get("/api/workspace/browse", params={"path": str(folder)})
        self.assertEqual(listing.status_code, 200)
        self.assertIn("child", str(listing.json()))


if __name__ == "__main__":
    unittest.main()
