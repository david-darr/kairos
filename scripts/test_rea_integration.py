"""REA remains opt-in, version-pinned, and usable through Kairos's MCP path."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

DATA = tempfile.TemporaryDirectory(prefix="kairos-rea-test-")
os.environ["JARVIS_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import integrations, permissions, rea_bridge, rea_integration, session_manager_store, tool_registry
from core.middleware import require_admin
from core.session_manager import session_manager
from routes import integrations_routes


class ReaIntegrationTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(integrations_routes.router)
        app.dependency_overrides[require_admin] = lambda: "test-admin"
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_prerequisite_check_does_not_download(self):
        with patch.object(rea_integration, "_version", side_effect=["v22.14.0", "10.0.0"]), \
             patch.object(rea_integration.shutil, "which", return_value="npx"), \
             patch.object(rea_integration, "download") as download:
            status = self.client.get("/api/integrations/rea/status")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["ready"])
        self.assertIn("22.19+", status.json()["reason"])
        download.assert_not_called()

    def test_unsupported_node_cannot_create_or_download(self):
        with patch.object(rea_integration, "status", return_value={"ready": False, "reason": "Unsupported Node"}), \
             patch.object(rea_integration, "download") as download:
            result = self.client.post("/api/integrations/rea")
        self.assertEqual(result.status_code, 400)
        self.assertIsNone(rea_integration.existing())
        download.assert_not_called()

    def test_explicit_add_uses_pinned_command_and_existing_mcp_check(self):
        with patch.object(rea_integration, "status", return_value={"ready": True}), \
             patch.object(rea_integration, "download", return_value="6.4.0") as download, \
             patch.object(integrations_routes.mcp_client, "check", new=AsyncMock(side_effect=lambda item_id: integrations.get_integration_masked(item_id))) as check:
            created = self.client.post("/api/integrations/rea")
        self.assertEqual(created.status_code, 200)
        item = created.json()
        self.addCleanup(integrations.delete_integration, item["id"])
        self.assertEqual(item["mcp_type"], "stdio")
        self.assertIn(rea_integration.REA_PACKAGE, item["args"])
        self.assertEqual(item["name"], "REA")
        download.assert_called_once()
        check.assert_awaited_once_with(item["id"])
        self.assertNotIn("REA", integrations.list_mcp_servers_runtime())
        selected = integrations.list_mcp_servers_runtime([item["id"]])
        self.assertIn("REA", selected)
        self.assertEqual(selected["REA"]["env"]["REA_MCP_INPUT_SCHEMA_PROFILE"], "compact")
        catalog = {entry["id"]: entry for entry in self.client.get("/api/integrations/catalog").json()}
        self.assertTrue(catalog["rea"]["added"])
        with patch.object(rea_integration, "download") as second_download:
            self.assertEqual(self.client.post("/api/integrations/rea").json()["id"], item["id"])
        second_download.assert_not_called()


class ReaBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session_id = session_manager.create_session("REA bridge test")["id"]
        command, args = rea_integration.command()
        self.item = integrations.create_mcp_server("REA", "stdio", command=command, args=args)
        self.tool = {"name": "inspect", "description": "Inspect a target", "schema": {"type": "object"}}
        self.client = AsyncMock()
        self.client.list_tools.return_value = [self.tool]
        self.client.call_tool.return_value = "Evidence ID 1"
        self.patcher = patch.object(rea_bridge.mcp_client, "PersistentClient", return_value=self.client)
        self.patcher.start()

    async def asyncTearDown(self):
        await rea_bridge.close(self.session_id)
        self.patcher.stop()
        integrations.delete_integration(self.item["id"])
        session_manager.delete_session(self.session_id)

    async def test_selection_pins_and_permission_gate_codex_calls(self):
        self.assertIn("not selected", await rea_bridge.search(self.session_id, "inspect"))
        self.client.start.assert_not_awaited()
        session_manager.set_integrations(self.session_id, [self.item["id"]])
        self.assertIn("inspect", await rea_bridge.search(self.session_id, "inspect"))
        self.assertIn("schema", await rea_bridge.describe(self.session_id, "inspect"))
        with patch.object(permissions, "decide", new=AsyncMock(return_value=permissions.Decision("deny", "Declined"))):
            denied = await tool_registry.call("rea_call_tool", {"name": "inspect", "arguments": {}},
                                              tool_registry.ToolContext(self.session_id, is_admin=True), "codex")
        self.assertEqual(denied, "Not run: Declined")
        self.client.call_tool.assert_not_awaited()
        with patch.object(permissions, "decide", new=AsyncMock(return_value=permissions.Decision("allow"))) as decide:
            allowed = await tool_registry.call("rea_call_tool", {"name": "inspect", "arguments": {}},
                                               tool_registry.ToolContext(self.session_id, is_admin=True), "codex")
        self.assertEqual(allowed, "Evidence ID 1")
        decide.assert_awaited_once()
        self.client.call_tool.assert_awaited_once_with("inspect", {})

        await rea_bridge.close(self.session_id)
        self.tool = {**self.tool, "description": "Changed description"}
        self.client.list_tools.return_value = [self.tool]
        self.assertEqual(await rea_bridge.search(self.session_id, "inspect"), "[]")
        self.assertIn("awaiting review", await rea_bridge.call(self.session_id, "inspect", {},
                                                                 f"chat:{self.session_id}", True))
        self.assertEqual(self.client.call_tool.await_count, 1)

    async def test_selection_change_during_approval_cancels_call(self):
        session_manager.set_integrations(self.session_id, [self.item["id"]])

        async def remove_selection(**_kwargs):
            session_manager.set_integrations(self.session_id, [])
            return permissions.Decision("allow")

        with patch.object(permissions, "decide", side_effect=remove_selection):
            result = await rea_bridge.call(self.session_id, "inspect", {}, f"chat:{self.session_id}", True)
        self.assertIn("changed", result)
        self.client.call_tool.assert_not_awaited()


def tearDownModule():
    session_manager_store.close()
    DATA.cleanup()


if __name__ == "__main__":
    unittest.main()
