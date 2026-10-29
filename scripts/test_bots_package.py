"""Portable packages against real persona/task stores and isolated data."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_data_support import TestDataDirectory
ENV = TestDataDirectory("kairos-package-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(ENV.name) / "vault")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import bot_package as pkg, bot_package_import as installer
from services.agent_service import agent_service
from services.task_service import task_service
from services import bot_record
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_admin
from routes.bot_lifecycle_routes import router


def package(**parts):
    return pkg.seal([{"key": "writer", "name": "Writer", "role": "Write", "soul": "Use clear prose.",
                      "routines": [{"name": "Review", "prompt": "Review the draft", "schedule_kind": "interval", "interval_seconds": 3600}]}], **parts)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.before = set(agent_service._agents)
        pkg._sections.clear()

    def tearDown(self):
        for task in list(task_service.list_tasks()):
            if task.get("agent_id") not in self.before:
                task_service.delete_task(task["id"])
        for ident in set(agent_service._agents) - self.before:
            agent_service.delete(ident)
        pkg._sections.clear()

    def install(self, value=None, **kw):
        inspected = pkg.inspect(pkg.canonical(value or package()), owner_user="owner")
        return pkg.import_(inspected["token"], owner_user="owner", **kw)

    def test_digest_canonical_size_and_tamper(self):
        value = package()
        self.assertEqual(pkg.digest(value), value["manifest"]["sha256"])
        self.assertEqual(pkg.canonical(value), pkg.canonical(dict(reversed(list(value.items())))))
        value["bots"][0]["soul"] = "tampered"
        with self.assertRaisesRegex(ValueError, "checksum"):
            pkg.inspect(json.dumps(value))
        value = package(); value["manifest"]["version"] = 2
        with self.assertRaisesRegex(ValueError, "version"):
            pkg.inspect(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "4 MB"):
            pkg.inspect(b" " * (pkg.MAX_BYTES + 1))

    def test_export_excludes_reach_and_secret_findings_block_download(self):
        a = agent_service.create("Portable", soul="Plain instructions", integration_ids=[])
        raw = pkg.export_bytes([a["id"]], owner_user="owner")
        bot = json.loads(raw)["bots"][0]
        for excluded in ("endpoint_id", "model_override", "integration_ids", "approval_mode", "tool_scope", "transcripts", "keep_signed_in", "owner_user", "peers", "paths", "id"):
            self.assertNotIn(excluded, bot)
        agent_service.update(a["id"], soul="api_key=abcdefghijk123456789")
        preview = pkg.export_preview([a["id"]])
        self.assertTrue(preview["redacted"])
        self.assertNotIn("abcdefghijk", str(preview["redacted"]))
        with self.assertRaisesRegex(ValueError, "secret"):
            pkg.export_bytes([a["id"]])

    def test_full_persona_only_paused_routines_disabled_connections(self):
        value = package(connections=[{"name": "sample", "url": "https://example.test/mcp", "header_names": ["Authorization"]}])
        value["bots"][0].update(approval_mode="auto", endpoint_id="bad", tool_scope={"allow": ["*"]})
        value["manifest"]["sha256"] = pkg.digest(value)
        result = self.install(value)
        a = agent_service.get(result["created"][0]["id"])
        self.assertEqual(a["approval_mode"], "full")
        self.assertEqual(a["integration_ids"], [])
        self.assertIsNone(a["endpoint_id"])
        self.assertTrue(all(not t["enabled"] for t in task_service.list_tasks() if t.get("agent_id") == a["id"]))
        draft = json.loads(next((Path(ENV.name) / "bot_lifecycle" / "connections").glob("*.json")).read_text())
        self.assertFalse(draft["enabled"])
        self.assertEqual(draft["headers"], {"Authorization": ""})

    def test_collision_selection_and_token_binding(self):
        self.install(); result = self.install()
        self.assertEqual(result["created"][0]["name"], "Writer 2")
        info = pkg.inspect(pkg.canonical(package()), owner_user="owner")
        with self.assertRaises(ValueError):
            pkg.import_(info["token"], owner_user="other")
        pkg.import_(info["token"], {"bots": []}, owner_user="owner")
        with self.assertRaises(ValueError):
            pkg.import_(info["token"], owner_user="owner")

    def test_failure_rolls_back_all_and_cleanup_failure_is_reported(self):
        before = set(agent_service._agents)
        with patch.object(task_service, "create_task", side_effect=RuntimeError("private failure")):
            with self.assertRaises(installer.ImportFailure) as raised:
                self.install()
        self.assertEqual(set(agent_service._agents), before)
        self.assertEqual(raised.exception.cleanup_errors, [])
        with patch.object(task_service, "create_task", side_effect=RuntimeError("failed")), patch.object(agent_service, "delete", side_effect=RuntimeError("cleanup")):
            with self.assertRaises(installer.ImportFailure) as raised:
                self.install()
        self.assertTrue(raised.exception.cleanup_errors)
        self.assertNotIn("private failure", str(raised.exception))

    def test_skill_staging_is_disabled_and_rolled_back(self):
        from types import SimpleNamespace
        calls = []
        adapter = SimpleNamespace(stage_package=lambda skill, **kw: calls.append(kw) or "receipt", remove_package_stage=lambda r: calls.append(r))
        value = package(skills=[{"name": "editing", "content": "# Editing\nUse short sentences."}])
        with patch.dict(sys.modules, {"services.bot_skill_import": adapter}):
            self.install(value)
        self.assertEqual(calls[0]["enabled"], False)

    def test_cap_and_registry_undo(self):
        value = package(sections={"rooms": {"name": "Review room"}})
        undos = []
        pkg.register_section("rooms", lambda ids: {}, lambda data, mapping: lambda: undos.append(mapping))
        pkg.register_section("z-fail", lambda ids: {}, lambda data, mapping: (_ for _ in ()).throw(ValueError("bad")))
        value["sections"]["z-fail"] = {}; value["manifest"]["sha256"] = pkg.digest(value)
        with self.assertRaises(installer.ImportFailure): self.install(value)
        self.assertEqual(len(undos), 1)
        with patch.object(bot_record, "MAX_BOTS", 0):
            with self.assertRaisesRegex(ValueError, "100"):
                self.install()

    def test_markdown_fences_secret_and_connection_validation(self):
        info = pkg.inspect(b"```json\n" + pkg.canonical(package()) + b"\n```")
        self.assertEqual(info["preview"]["counts"]["bots"], 1)
        for url in ("file:///etc/passwd", "http://example.test/mcp", "https://user:pass@example.test", "https://example.test?token=secret"):
            with self.assertRaises(ValueError):
                pkg.inspect(pkg.canonical(package(connections=[{"name": "bad", "url": url}])))


class RouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[require_admin] = lambda: "owner"
        self.web = TestClient(app)

    def test_inspect_bounds_extra_fields_and_import(self):
        response = self.web.post("/api/bot-lifecycle/packages/inspect", files={"file": ("team.json", pkg.canonical(package()))})
        self.assertEqual(response.status_code, 200, response.text)
        body = {"token": response.json()["token"], "selection": {"bots": []}}
        self.assertEqual(self.web.post("/api/bot-lifecycle/packages/import", json=body).status_code, 200)
        self.assertEqual(self.web.post("/api/bot-lifecycle/packages/import", json={**body, "owner_user": "other"}).status_code, 422)
        self.assertEqual(self.web.post("/api/bot-lifecycle/packages/inspect", files={"file": ("file.exe", b"x")}).status_code, 422)


if __name__ == "__main__": unittest.main()
