"""Roblox ownership, PKCE, recovery, Studio targeting and API contracts.
Uses isolated storage and simulated Roblox/Studio responses, never real tokens.
"""
import asyncio
import base64
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory
_data = TemporaryDirectory(prefix="roblox-")
os.environ["JARVIS_DATA_DIR"] = _data.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_data.name) / "vault")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import addons
addons.change("roblox", "install")
from core import custom_tabs, settings, roblox_workspace as workspace, tab_api, tool_registry
settings.update_settings(enabled_tab_templates=["roblox"])
custom_tabs.discover()
from kairos_tabs.roblox import accounts, routes


def result(text="ok", images=None, error=False):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)] + [
        SimpleNamespace(type="image", data=base64.b64encode(image).decode()) for image in (images or [])],
        structured_content=None, is_error=error)


class Stores(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_data.name)
        self.addCleanup(self.tmp.cleanup)
        self.patch = patch.object(workspace, "root", lambda: Path(self.tmp.name))
        self.patch.start(); self.addCleanup(self.patch.stop)

    def test_project_and_chat_ownership(self):
        row = workspace.create("alice", "Obstacle course")
        self.assertEqual(workspace.projects("bob"), [])
        for call in (lambda: workspace.project("bob", row["id"]),
                     lambda: workspace.chat("bob", row["id"]),
                     lambda: workspace.save_place("bob", row["id"], "x.rbxlx", b'<roblox version="4"/>')):
            with self.assertRaises(ValueError): call()
        sid = workspace.chat("alice", row["id"])
        self.assertEqual(workspace.chat("alice", row["id"]), sid)
        session = workspace.session_manager.get_session(sid)
        self.assertEqual(session["owner_user"], "alice")
        self.assertEqual(session["enabled_integration_ids"], [])
        self.assertEqual(Path(session["workspace_dir"]), workspace.folder(row["id"]))
        self.assertIn("reference", session["messages"][0]["content"])

    def test_place_copy_is_confined_and_validated(self):
        row = workspace.create("alice", "Local", "local")
        for filename, blob in [("../key.txt", b"secret"), ("a.rbxl", b"not a place"),
                               ("a.rbxlx", b"not XML"), ("a.rbxlx", b"")]:
            with self.assertRaises(ValueError): workspace.save_place("alice", row["id"], filename, blob)
        saved = workspace.save_place("alice", row["id"], "../../my game.rbxlx", b'<roblox version="4"/>')
        self.assertTrue(saved["backup"])
        self.assertNotIn("/", saved["backup_name"])
        self.assertFalse(saved["write_enabled"])
        self.assertNotIn("backup_sha256", saved)
        with self.assertRaises(ValueError): workspace.folder("../../outside")

    def test_launch_passes_argv_without_shell_and_preserves_copy(self):
        row = workspace.create("alice", 'Game " & echo no', "local")
        saved = workspace.save_place("alice", row["id"], "local.rbxlx", b'<roblox version="4"/>')
        exe = Path(self.tmp.name) / "Studio.exe"; exe.touch()
        with patch.object(workspace, "studio_paths", return_value=(exe, None, None)), patch.object(workspace.subprocess, "Popen") as launch:
            workspace.launch("alice", row["id"])
        argv = launch.call_args.args[0]
        self.assertEqual(argv[0], str(exe))
        self.assertNotIn('shell', launch.call_args.kwargs)
        work = Path(argv[argv.index("--localPlaceFile") + 1])
        self.assertNotEqual(work.name, saved["backup_name"])
        self.assertEqual(work.read_bytes(), b'<roblox version="4"/>')


class OAuth(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = {}
        self.read = patch.object(accounts.api, "read_json", side_effect=lambda k, default: copy.deepcopy(self.data.get(k, default)))
        self.write = patch.object(accounts.api, "write_json", side_effect=lambda k, v: self.data.update({k: copy.deepcopy(v)}))
        self.read.start(); self.write.start(); self.addCleanup(self.read.stop); self.addCleanup(self.write.stop)
        accounts._pending.clear(); accounts._refresh_locks.clear()
        accounts.configure("client", "http://localhost:8431/api/tab-roblox/oauth/callback")

    def start(self, user="alice"):
        return parse_qs(urlsplit(accounts.start(user)).query)

    async def finish(self, user="alice"):
        query = self.start(user)
        async def respond(method, url, **kwargs):
            return {"sub": "123", "preferred_username": "builder"} if url.endswith("userinfo") else {
                "access_token": "ACCESS-TEST", "refresh_token": "REFRESH-TEST", "expires_in": 900}
        with patch.object(accounts, "request", side_effect=respond) as remote:
            await accounts.finish(user, query["state"][0], "CODE-TEST")
        return query, remote

    async def test_pkce_state_owner_replay_and_encrypted_tokens(self):
        query = self.start()
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertNotIn("client_secret", query)
        with self.assertRaises(ValueError): await accounts.finish("bob", query["state"][0], "x")
        self.assertIn(query["state"][0], accounts._pending)
        await self.finish()
        self.assertTrue(accounts.status("alice")["connected"])
        self.assertFalse(accounts.status("bob")["connected"])
        self.assertNotIn("ACCESS-TEST", json.dumps(self.data))
        self.assertEqual(await accounts.access("alice"), "ACCESS-TEST")
        with self.assertRaises(ValueError): await accounts.finish("alice", query["state"][0], "x")

    async def test_expired_cancelled_and_reconfigured_signin(self):
        query = self.start(); accounts._pending[query["state"][0]]["expires"] = 0
        with self.assertRaises(ValueError): await accounts.callback(query["state"][0], "code")
        query = self.start()
        with self.assertRaises(ValueError): await accounts.callback(query["state"][0], "", "access_denied")
        await self.finish()
        accounts.configure("different-client", "http://localhost:8431/api/tab-roblox/oauth/callback")
        self.assertFalse(accounts.status("alice")["connected"])
        with self.assertRaises(ValueError): await accounts.access("alice")

    async def test_refresh_keeps_unrotated_refresh_token_and_disconnect_is_local_on_failure(self):
        await self.finish()
        self.data["account-" + accounts.key("alice") + ".json"]["expires"] = 0
        with patch.object(accounts, "request", AsyncMock(return_value={"access_token": "new", "expires_in": 900})):
            self.assertEqual(await accounts.access("alice"), "new")
        tokens = json.loads(accounts.api.decrypt(accounts.load("alice")["tokens"]))
        self.assertEqual(tokens["refresh_token"], "REFRESH-TEST")
        with patch.object(accounts, "request", AsyncMock(side_effect=ValueError("offline"))):
            response = await accounts.disconnect("alice")
        self.assertIn("warning", response)
        self.assertFalse(accounts.status("alice")["connected"])

    async def test_disconnect_cancels_a_signin_already_exchanging_tokens(self):
        query = self.start()
        async def respond(method, url, **kwargs):
            if url.endswith('token'):
                await accounts.disconnect('alice')
                return {"access_token": "a", "refresh_token": "r"}
            return {"sub": "123"}
        with patch.object(accounts, 'request', side_effect=respond):
            with self.assertRaises(ValueError): await accounts.callback(query['state'][0], 'code')
        self.assertFalse(accounts.status('alice')['connected'])

    async def test_library_public_and_authorized_with_partial_errors(self):
        await self.finish()
        async def respond(method, url, **kwargs):
            if "games.roblox.com" in url:
                return {"data": [{"id": 10, "name": "Public", "rootPlace": {"id": 20}}]}
            if url.endswith("resources"):
                return {"resource_infos": [{"resources": {"universe": {"ids": ["30", "40"]}}}]}
            if url.endswith("30"):
                return {"displayName": "Private", "rootPlace": "universes/30/places/50"}
            raise ValueError("refused")
        with patch.object(accounts, "request", side_effect=respond):
            library = await accounts.library("alice")
        self.assertEqual({g["name"] for g in library["games"]}, {"Public", "Private"})
        self.assertTrue(library["warnings"])
        self.assertIn("Local files", library["coverage"])

    def test_redirect_restrictions(self):
        for uri in ["https://evil.example/other", "http://evil.example/api/tab-roblox/oauth/callback",
                    "https://user:pass@site/api/tab-roblox/oauth/callback", "https://site/api/tab-roblox/oauth/callback?x=1"]:
            with self.assertRaises(ValueError): accounts.configure("client", uri)

    def test_url_client_id_is_rejected_even_from_old_saved_config(self):
        with self.assertRaises(ValueError): accounts.configure('https://github.com/msayib/roblox-dev-skill', 'http://localhost:8431/api/tab-roblox/oauth/callback')
        self.data['oauth-config.json']['client_id'] = 'https://github.com/msayib/roblox-dev-skill'
        self.assertFalse(accounts.safe_config()['configured'])
        with self.assertRaises(ValueError): accounts.start('alice')


class Studio(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_data.name); self.addCleanup(self.tmp.cleanup)
        p = patch.object(workspace, "root", lambda: Path(self.tmp.name)); p.start(); self.addCleanup(p.stop)
        self.row = workspace.create("alice", "Private", "cloud", "10", "20")
        self.pid = self.row["id"]
        self.sid = workspace.chat("alice", self.pid)
        self.native = SimpleNamespace(list_tools=AsyncMock(return_value=[{"name": n, "schema": {}} for n in
            ["script_read", "multi_edit", "execute_luau", "screen_capture", "start_stop_play", "store_image", "subagent", "upload_image"]]),
            call_result=AsyncMock(return_value=result()))
        for p in [patch.object(workspace, "client", AsyncMock(return_value=self.native)),
                  patch.object(workspace, "studios", AsyncMock(return_value=[dict(studio_id="one", place_id="20", name="Private")]))]:
            p.start(); self.addCleanup(p.stop)

    async def test_existing_game_requires_copy_and_explicit_edits(self):
        with self.assertRaises(ValueError): await workspace.bind("alice", self.pid, "one", True)
        await workspace.bind("alice", self.pid, "one")
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "multi_edit", {}, is_admin=True)
        answer = await workspace.tool(self.sid, "call", "script_read", {"target_file": "Script"}, is_admin=True)
        self.assertEqual(answer["text"], "ok")
        self.assertEqual(self.native.call_result.call_args.args[1]["studio_id"], "one")

    async def test_target_cross_user_tool_and_changed_place_refusal(self):
        with self.assertRaises(ValueError): await workspace.bind("bob", self.pid, "one")
        await workspace.bind("alice", self.pid, "one")
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "script_read", {"studio_id": "other"}, is_admin=True)
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "subagent", {}, is_admin=True)
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "tools", is_admin=False)
        with patch.object(workspace, "studios", AsyncMock(return_value=[dict(studio_id="one", place_id="999", name="Other")])):
            with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "script_read", {}, is_admin=True)

    async def test_snapshot_precedes_mutation_and_missing_backup_blocks(self):
        workspace.save_place("alice", self.pid, "copy.rbxlx", b'<roblox version="4"/>')
        await workspace.bind("alice", self.pid, "one", True)
        from core import permissions
        with patch.object(permissions, "decide", AsyncMock(return_value=SimpleNamespace(behavior="allow"))):
            await workspace.tool(self.sid, "call", "multi_edit", {"edits": []}, is_admin=True)
        calls = self.native.call_result.call_args_list
        self.assertEqual(calls[-2].args[0], "execute_luau")
        self.assertEqual(calls[-1].args[0], "multi_edit")
        snapshots = list(workspace.folder(self.pid).glob("scripts-*.json"))
        self.assertEqual(len(snapshots), 1)
        self.assertIn("script_sources", json.loads(snapshots[0].read_text()))
        row = workspace.project("alice", self.pid)
        (workspace.folder(self.pid) / row["backup_name"]).write_bytes(b"changed")
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "multi_edit", {}, is_admin=True)

    async def test_snapshot_failure_does_not_mutate_and_denied_prompt_does_not_snapshot(self):
        workspace.save_place("alice", self.pid, "copy.rbxlx", b'<roblox version="4"/>')
        await workspace.bind("alice", self.pid, "one", True)
        self.native.call_result.reset_mock()
        from core import permissions
        with patch.object(permissions, "decide", AsyncMock(return_value=SimpleNamespace(behavior="deny", reason="No"))):
            answer = await workspace.tool(self.sid, "call", "multi_edit", {}, is_admin=True)
        self.assertTrue(answer["text"].startswith("Not run:"))
        self.native.call_result.assert_not_called()
        self.native.call_result.return_value = result("cannot read", error=True)
        with patch.object(permissions, "decide", AsyncMock(return_value=SimpleNamespace(behavior="allow"))):
            with self.assertRaises(ValueError): await workspace.tool(self.sid, "call", "multi_edit", {}, is_admin=True)
        self.assertEqual(self.native.call_result.call_args.args[0], "execute_luau")

    async def test_serialization_disable_and_viewport_image_survive(self):
        await workspace.bind("alice", self.pid, "one")
        lock = workspace.studio_lock("one"); lock.acquire()
        try:
            with self.assertRaises(ValueError): await workspace.tool(self.sid, "tools", is_admin=True)
            with self.assertRaises(ValueError): workspace.unbind("alice", self.pid)
        finally: lock.release()
        self.native.call_result.return_value = result(images=[b"PNG fixture"])
        answer = await workspace.tool(self.sid, "call", "screen_capture", {}, is_admin=True)
        self.assertEqual(answer["images"], [b"PNG fixture"])
        with patch.object(workspace, "enabled", return_value=False):
            with self.assertRaises(ValueError): await workspace.tool(self.sid, "tools", is_admin=True)
        workspace.unbind("alice", self.pid)
        with self.assertRaises(ValueError): await workspace.tool(self.sid, "tools", is_admin=True)

    async def test_local_marker_and_cloud_experiment_mismatch(self):
        local = workspace.create("alice", "Experiment")
        with self.assertRaises(ValueError): await workspace.bind("alice", local["id"], "one", True)
        with patch.object(workspace, "studios", AsyncMock(return_value=[dict(studio_id="two", place_id="0", name="Local")])):
            with self.assertRaises(ValueError): await workspace.bind("alice", local["id"], "two", True)
            self.native.call_result.return_value = result(local["id"])
            await workspace.bind("alice", local["id"], "two", True)
            with self.assertRaises(ValueError): await workspace.bind("alice", self.pid, "two", False)

    async def test_playtest_stop_does_not_require_edit_datamodel_snapshot(self):
        local = workspace.create('alice', 'Playtest')
        sid = workspace.chat('alice', local['id'])
        workspace.update('alice', local['id'], studio_id='play', write_enabled=True)
        async def native(name, args):
            if name == 'execute_luau':
                if args['datamodel_type'] == 'Edit': return result('Edit unavailable while playing', error=True)
                self.assertNotIn('GetDescendants', args['code'])
                return result(local['id'])
            self.assertEqual(name, 'start_stop_play')
            return result('Stopped')
        self.native.call_result.side_effect = native
        from core import permissions
        with patch.object(workspace, 'studios', AsyncMock(return_value=[dict(studio_id='play', place_id='0', name='Test')])), \
             patch.object(permissions, 'decide', AsyncMock(return_value=SimpleNamespace(behavior='allow'))):
            answer = await workspace.tool(sid, 'call', 'start_stop_play', {}, is_admin=True)
        self.assertEqual(answer['text'], 'Stopped')

    async def test_reference_paths_cannot_read_other_projects_or_host_files(self):
        await workspace.bind('alice', self.pid, 'one')
        for source in ['C:/Windows/win.ini', '../outside.png']:
            with self.assertRaises(ValueError):
                await workspace.tool(self.sid, 'call', 'store_image', {'file_path':source}, is_admin=True)

    async def test_plain_text_unavailable_edit_falls_back_to_server(self):
        local = workspace.create('alice', 'Play'); sid = workspace.chat('alice', local['id'])
        workspace.update('alice', local['id'], studio_id='play', write_enabled=True)
        calls = []
        async def native(name, args):
            calls.append((name, args))
            if name == 'execute_luau':
                return result('Error: Edit DataModel unavailable') if args['datamodel_type'] == 'Edit' else result(json.dumps({'project_id':local['id']}))
            return result('Stopped')
        self.native.call_result.side_effect = native
        from core import permissions
        with patch.object(workspace, 'studios', AsyncMock(return_value=[dict(studio_id='play', place_id='0', name='Play')])), \
             patch.object(permissions, 'decide', AsyncMock(return_value=SimpleNamespace(behavior='allow'))):
            answer = await workspace.tool(sid, 'call', 'start_stop_play', {'is_start':False}, is_admin=True)
        self.assertEqual(answer['text'], 'Stopped')
        self.assertTrue(any(args.get('datamodel_type') == 'Server' for _,args in calls))
        self.assertEqual(sum(name == 'start_stop_play' for name,_ in calls), 1)

    async def test_nil_marker_tries_other_models_but_foreign_marker_never_passes(self):
        local = workspace.create('alice', 'Play'); row={**workspace.project('alice',local['id']), 'studio_id':'play'}
        windows=[dict(studio_id='play',place_id='0',name='Play')]
        self.native.call_result.side_effect = [result('nil'),result(json.dumps({'project_id':local['id']}))]
        answer = await workspace.verify_target(row,windows)
        self.assertEqual(answer['verified_datamodel'],'Server')
        self.native.call_result.reset_mock(); self.native.call_result.side_effect = None
        self.native.call_result.return_value = result(json.dumps({'project_id':'f'*32}))
        with self.assertRaises(ValueError): await workspace.verify_target(row,windows)
        self.assertEqual(self.native.call_result.await_count,1)
        self.assertEqual(workspace.marker_ids(result('Error: '+local['id'])),[])
        self.assertEqual(workspace.marker_ids(result('Some console text '+local['id'])),[])

    async def test_all_unavailable_fail_closed_and_record_refusal(self):
        local=workspace.create('alice','Play'); sid=workspace.chat('alice',local['id'])
        workspace.update('alice',local['id'],studio_id='play',write_enabled=True)
        self.native.call_result.return_value=result('{}')
        with patch.object(workspace,'studios',AsyncMock(return_value=[dict(studio_id='play',place_id='0',name='Play')])):
            with self.assertRaises(ValueError): await workspace.tool(sid,'call','start_stop_play',{'is_start':False},is_admin=True)
        self.assertTrue(all(call.args[0]=='execute_luau' for call in self.native.call_result.call_args_list))
        event=workspace.project('alice',local['id'])['activity'][-1]
        self.assertFalse(event['ok']); self.assertIn('identity is unavailable',event['detail'])

    async def test_reopen_finds_existing_and_refuses_duplicate_or_unsaved_replacement(self):
        local=workspace.create('alice','Already open')
        workspace.activity('alice',local['id'],'Opened in native Studio')
        self.native.call_result.return_value=result(json.dumps({'legacy_id':local['id']}))
        window=dict(studio_id='play',place_id='0',name='Place1')
        with patch.object(workspace,'studios',AsyncMock(return_value=[window])),patch.object(workspace.subprocess,'Popen') as launch:
            answer=await workspace.open_existing_or_launch('alice',local['id'])
            self.assertFalse(answer['opened']); self.assertEqual(answer['studio_id'],'play'); launch.assert_not_called()
        with patch.object(workspace,'studios',AsyncMock(return_value=[window,{**window,'studio_id':'second'}])),patch.object(workspace.subprocess,'Popen') as launch:
            with self.assertRaises(ValueError): await workspace.open_existing_or_launch('alice',local['id'])
            launch.assert_not_called()
        with patch.object(workspace,'studios',AsyncMock(return_value=[])),patch.object(workspace.subprocess,'Popen') as launch:
            with self.assertRaises(ValueError): await workspace.open_existing_or_launch('alice',local['id'])
            launch.assert_not_called()

    async def test_connection_health_and_text_errors_are_not_success(self):
        await workspace.bind('alice',self.pid,'one')
        self.native.call_result.return_value=result('Error: Could not find any instances')
        health=await workspace.connection('alice',self.pid)
        self.assertEqual(health['state'],'needs_attention')
        answer=await workspace.tool(self.sid,'call','script_read',{},is_admin=True)
        self.assertTrue(answer['text'].startswith('Tool error:'))
        self.assertFalse(workspace.project('alice',self.pid)['activity'][-1]['ok'])

    async def test_health_check_does_not_interrupt_a_busy_studio(self):
        await workspace.bind('alice',self.pid,'one')
        self.native.call_result.reset_mock()
        lock=workspace.studio_lock('one'); lock.acquire()
        try:
            health=await workspace.connection('alice',self.pid)
            self.assertEqual(health['state'],'busy'); self.native.call_result.assert_not_called()
        finally: lock.release()

    async def test_pairing_refuses_a_place_that_changes_during_marker_upgrade(self):
        local=workspace.create('alice','Legacy')
        self.native.call_result.side_effect=[result(json.dumps({'legacy_id':local['id']})),result('Error: Place changed before pairing')]
        with patch.object(workspace,'studios',AsyncMock(return_value=[dict(studio_id='play',place_id='0',name='Play')])):
            with self.assertRaises(ValueError): await workspace.bind('alice',local['id'],'play',True)
        self.assertIsNone(workspace.project('alice',local['id'])['studio_id'])

    async def test_tool_discovery_is_compact_with_schema_on_demand(self):
        await workspace.bind('alice',self.pid,'one')
        listed=json.loads((await workspace.tool(self.sid,'tools',is_admin=True))['text'])
        self.assertTrue(all('schema' not in tool for tool in listed))
        described=json.loads((await workspace.tool(self.sid,'tools','execute_luau',is_admin=True))['text'])
        self.assertEqual(len(described),1); self.assertIn('schema',described[0])
        self.assertEqual(self.native.list_tools.await_count,1)


class SkillReferences(unittest.TestCase):
    def test_vendored_references_match_the_pinned_manifest(self):
        import hashlib
        root=Path(__file__).resolve().parents[1]/'addon_packages'/'roblox'/'skills'/'roblox-dev-skill'
        manifest=json.loads((root/'UPSTREAM.json').read_text(encoding='utf-8'))
        self.assertRegex(manifest['commit'],r'^[a-f0-9]{40}$')
        self.assertEqual(len(manifest['sha256']),15)
        for name, digest in manifest['sha256'].items():
            self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),digest,name)

    def test_nested_seed_read_limits_and_no_clobber(self):
        from services import skills_service, skill_curator
        from core import memory_tools
        with tempfile.TemporaryDirectory(dir=_data.name) as directory:
            root = Path(directory); templates=root/'templates'; target=root/'skills'
            source=templates/'reference-fixture'; (source/'references').mkdir(parents=True)
            (source/'SKILL.md').write_text('---\nname: reference-fixture\ndescription: Fixture\n---\nUse the guide.', encoding='utf-8')
            (source/'references'/'guide.md').write_text('Nested guide', encoding='utf-8')
            saved={}
            with patch.object(skills_service,'SKILL_TEMPLATES_DIR',str(templates)), \
                 patch.object(skills_service,'SKILLS_DIR',str(target)), \
                 patch.object(settings,'get_setting',side_effect=lambda k:saved.get(k)), \
                 patch.object(settings,'update_settings',side_effect=lambda **kw:saved.update(kw)), \
                 patch.object(skill_curator,'record'), patch.object(skill_curator,'model_visible',return_value=True):
                skills_service.seed_default_skills()
                guide=target/'reference-fixture'/'references'/'guide.md'
                self.assertEqual(memory_tools.read_skill('reference-fixture','references/guide.md'),'Nested guide')
                guide.write_text('User edit',encoding='utf-8')
                skills_service.seed_default_skills()
                self.assertEqual(guide.read_text(),'User edit')
                for bad in ['../outside.md','/outside.md','references/../../outside.md','references\\guide.md']:
                    with self.assertRaises(ValueError): memory_tools.read_skill('reference-fixture',bad)
                guide.write_text('x'*100001,encoding='utf-8')
                with self.assertRaises(ValueError): memory_tools.read_skill('reference-fixture','references/guide.md')


class Routes(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI(); self.app.include_router(routes.router)
        self.app.dependency_overrides[tab_api.require_user] = lambda: "alice"
        self.app.dependency_overrides[tab_api.require_admin] = lambda: "alice"
        self.client = TestClient(self.app); self.addCleanup(self.client.close)

    def test_project_isolation_and_callback_without_cookie(self):
        row = self.client.post('/api/tab-roblox/projects', json={"name": "Routes"}).json()
        self.app.dependency_overrides[tab_api.require_user] = lambda: "bob"
        self.assertEqual(self.client.get('/api/tab-roblox/projects/' + row['id']).status_code, 400)
        self.assertEqual(self.client.get('/api/tab-roblox/oauth/callback?state=unknown&code=secret').status_code, 400)
        self.assertNotIn('secret', self.client.get('/api/tab-roblox/oauth/callback?state=unknown&code=secret').text)

    def test_native_routes_require_authentication(self):
        self.app.dependency_overrides.clear()
        from core import auth
        with patch.object(auth, 'UI_SECRET', 'fixture-secret'):
            self.assertEqual(self.client.get('/api/tab-roblox/studios').status_code, 401)


if __name__ == '__main__':
    unittest.main()
