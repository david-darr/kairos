"""Isolated creative account/style contracts; no native app or paid requests."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory
_data = TemporaryDirectory(prefix="creative-")
os.environ["JARVIS_DATA_DIR"] = _data.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_data.name) / "vault")
from core import addons
for ident in addons.IDS: addons.change(ident, "install")
from core import creative_tools as creative, roblox_style as style, roblox_assets as assets, roblox_workspace as workspace
from core import permissions, settings, tool_registry
from core.session_manager import session_manager
from core.secret_storage import decrypt


class Isolated:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_data.name); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for obj, field, value in [(workspace, "ROOT", self.root / "roblox"),
                                  (creative, "FILE", str(self.root / "creative.json")),
                                  (permissions, "PERMISSIONS_FILE", str(self.root / "permissions.json"))]:
            p = patch.object(obj, field, value); p.start(); self.addCleanup(p.stop)
        settings.update_settings(enabled_tab_templates=["roblox"])
        self.project = workspace.create("alice", "Islands", roblox_user_id="123")
        self.pid = self.project["id"]; self.sid = workspace.chat("alice", self.pid)
        self.ctx = tool_registry.ToolContext(session_id=self.sid, is_admin=True)
        creative._busy.clear(); creative._refresh_locks.clear()

    def pair(self):
        creative.connect_blender("alice", 9876, "private-pairing-token-12345")
        creative._update("alice", "blender", blend_file="C:/test/game.blend")
        creative.select("alice", ["blender"], sid=self.sid)


class Styles(Isolated, unittest.TestCase):
    def test_user_and_roblox_account_separation(self):
        style.change("alice", self.pid, "add", key="colors", value="warm")
        same = workspace.create("alice", "Same", roblox_user_id="123")
        other = workspace.create("alice", "Other", roblox_user_id="456")
        bob = workspace.create("bob", "Bob", roblox_user_id="123")
        self.assertIn("warm", style.skill("alice", same["id"]))
        self.assertNotIn("warm", style.skill("alice", other["id"]))
        self.assertNotIn("warm", style.skill("bob", bob["id"]))
        with self.assertRaises(ValueError): style.get("bob", self.pid)

    def test_suggestions_need_latest_user_evidence_and_confirmation(self):
        session_manager.append_message(self.sid, "user", "I prefer rounded panels.")
        with self.assertRaises(ValueError): style.model_tool(self.sid, "suggest", key="corners", value="round", source_quote="not their words")
        style.model_tool(self.sid, "suggest", key="corners", value="round", source_quote="I prefer rounded panels.")
        state = style.get("alice", self.pid); entry = state["entries"][0]
        self.assertEqual(entry["status"], "suggested"); self.assertNotIn('"round"', state["skill"])
        style.change("alice", self.pid, "confirm", entry_id=entry["id"])
        self.assertIn('"round"', style.skill("alice", self.pid))
        session_manager.append_message(self.sid, "user", "Make it blue.")
        with self.assertRaises(ValueError): style.model_tool(self.sid, "suggest", source_quote="I prefer rounded panels.")
        with self.assertRaises(ValueError): style.model_tool(self.sid, "confirm")

    def test_explicit_preferences_locks_and_learning_off(self):
        style.context(self.sid, "Remember my UI colors: warm sunset")
        state = style.get("alice", self.pid); entry = state["entries"][0]
        style.change("alice", self.pid, "lock", entry_id=entry["id"], locked=True)
        style.context(self.sid, "Remember my UI colors: cold blue")
        self.assertIn("warm sunset", style.skill("alice", self.pid))
        with self.assertRaises(ValueError): style.change("alice", self.pid, "add", key="colors", value="cold blue", suggested=True)
        style.change("alice", self.pid, "learning", learning=False)
        session_manager.append_message(self.sid, "user", "I like simple models.")
        self.assertIn("disabled", style.model_tool(self.sid, "suggest", category="model", key="detail", value="simple", source_quote="I like simple models."))
        style.context(self.sid, 'The example says "Remember my UI text: tiny"')
        style.context(self.sid, 'Explain this example:\n```text\nRemember my UI text: tiny\n```')
        self.assertEqual(len(style.get("alice", self.pid)["entries"]), 1)

    def test_project_override_preset_and_history(self):
        first = style.change("alice", self.pid, "add", key="colors", value="warm")
        style.change("alice", self.pid, "add", key="colors", value="cool", project_only=True)
        self.assertIn('"cool"', style.skill("alice", self.pid)); self.assertNotIn('"warm"', style.skill("alice", self.pid))
        style.change("alice", self.pid, "clear_project")
        style.change("alice", self.pid, "edit", entry_id=first["entries"][0]["id"], value="pastel")
        style.change("alice", self.pid, "restore", revision=first["revision"])
        self.assertIn('"warm"', style.skill("alice", self.pid))
        style.select("alice", self.pid, "scifi"); self.assertEqual(style.get("alice", self.pid)["entries"], [])
        style.select("alice", self.pid, "default"); self.assertIn('"warm"', style.skill("alice", self.pid))
        with self.assertRaises(ValueError): style.select("alice", self.pid, "../escape")

    def test_project_override_can_override_a_locked_personal_default(self):
        state = style.change("alice", self.pid, "add", key="colors", value="warm", locked=True)
        style.change("alice", self.pid, "add", key="colors", value="cool", project_only=True)
        self.assertIn('"cool"', style.skill("alice", self.pid))
        self.assertEqual(style.get("alice", self.pid)["entries"][0]["value"], "warm")

    def test_forget_removes_entry_from_restorable_history(self):
        state = style.change("alice", self.pid, "add", key="colors", value="warm")
        eid = state["entries"][0]["id"]
        style.change("alice", self.pid, "edit", entry_id=eid, value="pastel")
        state = style.change("alice", self.pid, "forget", entry_id=eid)
        self.assertFalse(any(e["id"] == eid for v in state["history"] for e in v["entries"]))

    def test_edit_suggestion_respects_locked_existing_and_replaces_unlocked(self):
        state = style.change("alice", self.pid, "add", key="colors", value="warm")
        first = state["entries"][0]["id"]
        state = style.change("alice", self.pid, "add", key="colors", value="cool", suggested=True)
        suggestion = state["entries"][-1]["id"]
        style.change("alice", self.pid, "lock", entry_id=first, locked=True)
        with self.assertRaises(ValueError): style.change("alice", self.pid, "edit", entry_id=suggestion, value="cool")
        style.change("alice", self.pid, "lock", entry_id=first, locked=False)
        state = style.change("alice", self.pid, "edit", entry_id=suggestion, value="cool")
        self.assertEqual(len(state["entries"]), 1)

    def test_asset_provenance_requires_actual_project_file_and_strips_signed_urls(self):
        file = workspace.folder(self.pid) / "model.glb"; file.write_bytes(b"example")
        row = assets.model_tool(self.sid, "record", name="Tree", source="blender", local_file="model.glb",
                                reference="https://example.org/tree?token=secret#key", import_status="exported")
        self.assertEqual(row["reference"], "https://example.org/tree")
        self.assertEqual(assets.listing("alice", self.pid)[0]["import_status"], "exported")
        for path in ("../outside", "C:/secret", "missing.glb"):
            with self.assertRaises(ValueError): assets.record("alice", self.pid, name="x", source="user", local_file=path)
        with self.assertRaises(ValueError): assets.listing("bob", self.pid)
        updated = assets.record("alice", self.pid, name="Tree", source="roblox", target_asset_id="12345", import_status="verified", asset_id=row["id"])
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["history"][0]["source"], "blender")
        self.assertEqual(updated["history"][0]["reference"], "https://example.org/tree")


class Connections(Isolated, unittest.IsolatedAsyncioTestCase):
    async def test_oauth_round_trip_is_owner_scoped_and_encrypted(self):
        from mcp.shared.auth import OAuthToken
        state = "random-test-state"
        async def connect(url, provider):
            self.assertEqual(url, creative.HIGGSFIELD)
            await provider.context.redirect_handler('https://example.test/authorize?state=' + state)
            result = await provider.context.callback_handler()
            self.assertEqual(result.code, 'returned-code')
            await provider.context.storage.set_tokens(OAuthToken(access_token='private-access-token', token_type='Bearer', expires_in=3600))
        with patch.object(creative.mcp_oauth, '_connect_signed_in', side_effect=connect):
            start = await creative.sign_in('alice', 'http://127.0.0.1:8420/api/creative/oauth/callback')
            self.assertIn(state, start['url'])
            await creative.callback(state, 'returned-code')
        self.assertTrue(creative.catalog('alice')[1]['connected'])
        self.assertFalse(creative.catalog('bob')[1]['connected'])
        self.assertNotIn('private-access-token', Path(creative.FILE).read_text())
        with self.assertRaises(ValueError): await creative.callback(state, 'returned-code')

    async def test_full_python_is_visible_in_approval_and_oversized_requests_are_rejected(self):
        self.pair()
        code = "# " + "x" * 6000 + "\nprint('visible-tail')"
        surface = self.ctx.permission_surface; channel = permissions.open_channel(surface)
        try:
            task = asyncio.create_task(creative.tool(self.ctx, "call", "blender", "execute", {"code": code}))
            prompt = await asyncio.wait_for(channel.get(), 2)
            self.assertIn("visible-tail", prompt["arguments"])
            permissions.answer(prompt["id"], "deny", "alice"); await task
            with self.assertRaises(ValueError):
                await creative.tool(self.ctx, "call", "blender", "execute", {"code": "x" * 81000})
        finally: permissions.close_channel(surface)

    async def test_unattended_paid_calls_fail_closed_and_busy_calls_do_not_overlap(self):
        self.pair()
        with patch.object(creative, "_blender", new_callable=AsyncMock) as call:
            result = await creative.tool(self.ctx, "call", "blender", "execute", {"code": "print(1)"})
            self.assertIn("Not run", result["text"]); call.assert_not_awaited()
        creative._busy.add(("alice", "blender"))
        try:
            with self.assertRaises(ValueError): await creative.tool(self.ctx, "call", "blender", "inspect")
        finally: creative._busy.clear()

    async def test_pairing_is_encrypted_private_and_not_selected_implicitly(self):
        self.pair()
        raw = creative._account("alice", "blender")
        self.assertEqual(decrypt(raw["token"]), "private-pairing-token-12345")
        self.assertNotIn("private-pairing", Path(creative.FILE).read_text())
        self.assertNotIn("token", json.dumps(creative.catalog("alice")))
        self.assertFalse(creative.catalog("bob")[0]["connected"])
        with self.assertRaises(ValueError): creative.choices("bob", sid=self.sid)
        sid = session_manager.create_session("Other", owner_user="alice")["id"]
        self.assertEqual(creative.principal(sid)[1], [])

    async def test_auto_mode_still_asks_and_deny_does_not_execute(self):
        self.pair(); session_manager.set_permission_mode(self.sid, "auto")
        surface = self.ctx.permission_surface; channel = permissions.open_channel(surface)
        try:
            with patch.object(creative, "_blender", new_callable=AsyncMock) as call:
                task = asyncio.create_task(creative.tool(self.ctx, "call", "blender", "execute", {"code": "print(1)"}))
                prompt = await asyncio.wait_for(channel.get(), 2)
                self.assertEqual(prompt["tool"], "creative_tools"); self.assertFalse(task.done())
                self.assertTrue(all(c["scope"] == "once" for c in prompt["choices"]))
                permissions.answer(prompt["id"], "deny", "alice")
                self.assertIn("Not run", (await task)["text"]); call.assert_not_awaited()
        finally: permissions.close_channel(surface)

    async def test_approval_sends_bound_file_and_keeps_images(self):
        self.pair()
        with patch.object(permissions, "decide", new_callable=AsyncMock, return_value=permissions.Decision("allow")) as decide, \
             patch.object(creative, "_blender", new_callable=AsyncMock, return_value={"file": "C:/test/game.blend", "checkpoint": "copy.blend"}) as call:
            await creative.tool(self.ctx, "call", "blender", "execute", {"code": "print(1)"})
            self.assertTrue(decide.call_args.kwargs["force_prompt"])
            self.assertEqual(call.call_args.args[2]["expected_file"], "C:/test/game.blend")
            self.assertEqual(creative.jobs("alice")[-1]["state"], "completed")
        with patch.object(creative, "_blender", new_callable=AsyncMock, return_value={"image": base64.b64encode(b"png").decode()}) as call:
            result = await creative.tool(self.ctx, "call", "blender", "viewport")
            self.assertEqual(result["images"], [b"png"])

    async def test_uncertain_request_is_not_retried_and_only_owner_resolves(self):
        self.pair()
        with patch.object(permissions, "decide", new_callable=AsyncMock, return_value=permissions.Decision("allow")), \
             patch.object(creative, "_blender", new_callable=AsyncMock, side_effect=TimeoutError) as call:
            with self.assertRaises(TimeoutError): await creative.tool(self.ctx, "call", "blender", "execute", {"code": "a=1"})
            self.assertEqual(creative.jobs("alice")[-1]["state"], "uncertain")
            with self.assertRaises(ValueError): await creative.tool(self.ctx, "call", "blender", "execute", {"code": "a=1"})
            self.assertEqual(call.await_count, 1)
        jid = creative.jobs("alice")[-1]["id"]
        with self.assertRaises(ValueError): creative.resolve_job("bob", jid)
        creative.resolve_job("alice", jid); self.assertEqual(creative.jobs("alice")[-1]["state"], "reviewed")

    async def test_revoke_while_approval_pending_never_executes(self):
        self.pair()
        async def revoke(**kwargs):
            creative.disconnect("alice", "blender"); return permissions.Decision("allow")
        with patch.object(permissions, "decide", side_effect=revoke), patch.object(creative, "_blender", new_callable=AsyncMock) as call:
            with self.assertRaises(ValueError): await creative.tool(self.ctx, "call", "blender", "execute", {"code": "print(1)"})
            call.assert_not_awaited()

    async def test_stale_oauth_writer_cannot_resurrect_disconnected_account(self):
        row = creative._update("alice", "higgsfield", status="Signing in")
        storage = creative.TokenStorage("alice", "http://127.0.0.1/callback", row["epoch"])
        creative.disconnect("alice", "higgsfield")
        from mcp.shared.auth import OAuthToken
        with self.assertRaises(ValueError): await storage.set_tokens(OAuthToken(access_token="secret", token_type="Bearer"))
        self.assertEqual(creative._account("alice", "higgsfield"), {})
        with self.assertRaises(ValueError): creative._update("alice", "higgsfield", expected_epoch=row["epoch"], status="Connected")

    async def test_bot_inherits_only_explicit_matching_binding(self):
        self.pair()
        sid = session_manager.create_session("Bot")["id"]
        session_manager.set_agent(sid, "bot1", "bot")
        with patch("services.agent_service.agent_service.get", return_value={"id": "bot1"}):
            creative.select("alice", ["blender"], agent_id="bot1")
        self.assertEqual(creative.principal(sid, "bot1"), ("alice", ["blender"]))
        owned = session_manager.create_session("Bob's bot chat", owner_user="bob")["id"]
        session_manager.set_agent(owned, "bot1", "bot")
        self.assertEqual(creative.principal(owned, "bot1"), ("bob", []))

    async def test_schema_changes_are_held_until_explicit_review(self):
        creative._update("alice", "higgsfield", oauth={"tokens": "fake"})
        creative.select("alice", ["higgsfield"], sid=self.sid)
        schema = {"type": "object", "properties": {"prompt": {"type": "string"}}}
        tool = NS(name="generate_image", description="Make image", input_schema=schema, annotations=NS(read_only_hint=False))
        client = NS(list_tools=AsyncMock(return_value=NS(tools=[tool])), call_tool=AsyncMock(return_value=NS(content=[NS(type="text", text="job-1")], is_error=False)))
        class Client:
            async def __aenter__(self): return client
            async def __aexit__(self, *args): pass
        with patch.object(creative, "_config", new_callable=AsyncMock, return_value={}), patch.object(creative.mcp_client, "_client", return_value=Client()), \
             patch.object(permissions, "decide", new_callable=AsyncMock, return_value=permissions.Decision("allow")) as decide:
            await creative.check("alice", "higgsfield")
            await creative.tool(self.ctx, "call", "higgsfield", "generate_image", {"prompt": "tree"})
            self.assertTrue(decide.call_args.kwargs["force_prompt"])
            tool.description = "Changed generation behavior"
            with self.assertRaises(ValueError): await creative.tool(self.ctx, "call", "higgsfield", "generate_image", {"prompt": "tree"})
            self.assertEqual(client.call_tool.await_count, 1)
            self.assertEqual(creative.catalog("alice")[1]["held_tools"], ["generate_image"])
            await creative.check("alice", "higgsfield", accept=True)
            await creative.tool(self.ctx, "call", "higgsfield", "generate_image", {"prompt": "tree2"})
            self.assertEqual(client.call_tool.await_count, 2)

    async def test_blender_uses_only_authenticated_loopback_without_environment_proxy(self):
        self.pair()
        response = NS(status_code=200, json=lambda: {"file": "game.blend"})
        client = NS(post=AsyncMock(return_value=response))
        class HTTP:
            async def __aenter__(self): return client
            async def __aexit__(self, *args): pass
        with patch.object(creative.httpx, "AsyncClient", return_value=HTTP()) as http:
            await creative._blender("alice", "inspect")
            self.assertFalse(http.call_args.kwargs["trust_env"])
            self.assertEqual(client.post.call_args.args[0], "http://127.0.0.1:9876/kairos")
            self.assertIn("Bearer private-pairing", client.post.call_args.kwargs["headers"]["Authorization"])


class Routes(Isolated, unittest.TestCase):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routes import creative_routes
        self.routes = creative_routes
        app = FastAPI(); app.include_router(creative_routes.router)
        app.dependency_overrides[creative_routes.require_user] = lambda: "bob"
        app.dependency_overrides[creative_routes.require_admin] = lambda: "alice"
        self.client = TestClient(app)

    def test_private_selection_and_admin_bot_boundary(self):
        response = self.client.get('/api/creative/selection', params={"session_id": self.sid})
        self.assertEqual(response.status_code, 400)
        with patch.object(self.routes.auth_manager, "is_admin", return_value=False):
            self.assertEqual(self.client.get('/api/creative/selection?agent_id=bot').status_code, 403)
        self.assertEqual(self.client.get('/api/creative/selection').status_code, 400)

    def test_pair_route_returns_no_token_and_addon_is_downloadable(self):
        response = self.client.post('/api/creative/blender', json={"port": 9876, "token": "secret-pairing-token-12345"})
        self.assertEqual(response.status_code, 200); self.assertNotIn("token", response.text)
        response = self.client.get('/api/creative/blender/addon')
        self.assertEqual(response.status_code, 200); self.assertIn("Kairos Creative Connection", response.text)
        self.assertEqual(self.client.get('/api/creative/oauth/callback?state=invalid').status_code, 400)

    def test_other_admin_cannot_approve_private_account_request(self):
        from routes import permission_routes
        pending = NS(tool="creative_tools", arguments={"account_owner": "alice"}, surface=f"chat:{self.sid}")
        with patch.object(permissions, 'pending_request', return_value=pending), patch.object(permissions, 'answer') as answer:
            from fastapi import HTTPException, Request
            request = Request({"type": "http", "method": "POST", "path": "/api/permissions/request/answer", "headers": []})
            with self.assertRaises(HTTPException) as failure:
                asyncio.run(permission_routes.answer('request', permission_routes.Answer(choice='once'), request, user='bob'))
            self.assertEqual(failure.exception.status_code, 403); answer.assert_not_called()


class BlenderAddon(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_data.name); self.addCleanup(self.tmp.cleanup)
        self.events = []
        self.bpy = NS(data=NS(filepath=str(Path(self.tmp.name) / 'game.blend')), context=NS(scene=NS(objects=[])),
                      types=NS(Operator=object, Panel=object), ops=NS(wm=NS(save_as_mainfile=lambda **kwargs: (self.events.append(('save', kwargs)) or {'FINISHED'}))))
        path = Path(__file__).resolve().parents[1] / 'addon_packages/blender/desktop/kairos_blender.py'
        spec = importlib.util.spec_from_file_location('blender_addon_test', path)
        self.addon = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"bpy": self.bpy}): spec.loader.exec_module(self.addon)

    def test_saved_file_identity_and_checkpoint_before_python(self):
        current = self.bpy.data.filepath
        self.assertEqual(self.addon._perform('inspect', {})['file'], current)
        with self.assertRaises(ValueError): self.addon._perform('execute', {"code": "print(1)"})
        with self.assertRaises(ValueError): self.addon._perform('execute', {"expected_file": "other.blend", "code": "print(1)"})
        result = self.addon._perform('execute', {"expected_file": current, "code": "print('made tree')"})
        self.assertTrue(self.events[0][1]['copy']); self.assertIn('made tree', result['output'])
        self.bpy.data.filepath = ''
        with self.assertRaises(ValueError): self.addon._perform('execute', {"expected_file": current, "code": "print(1)"})

    def test_failed_checkpoint_prevents_execution(self):
        self.bpy.ops.wm.save_as_mainfile = Mock(side_effect=OSError('full disk'))
        self.bpy.executed = False
        with self.assertRaises(OSError): self.addon._perform('execute', {"expected_file": self.bpy.data.filepath, "code": "bpy.executed = True"})
        self.assertFalse(self.bpy.executed)
        self.bpy.ops.wm.save_as_mainfile = Mock(return_value={'CANCELLED'})
        with self.assertRaises(ValueError): self.addon._perform('execute', {"expected_file": self.bpy.data.filepath, "code": "bpy.executed = True"})
        self.assertFalse(self.bpy.executed)


if __name__ == '__main__': unittest.main()
