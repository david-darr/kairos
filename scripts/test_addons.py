"""Optional add-on lifecycle, migration and access boundaries. No external calls."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_data = tempfile.TemporaryDirectory(prefix='kairos-addons-', ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR'] = _data.name
os.environ['JARVIS_VAULT_DIR'] = str(Path(_data.name) / 'vault')
from core import addons, custom_tabs, settings, tool_registry
from services import skills_service, skill_curator


class Addons(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_data.name)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.values = {}
        for obj, name, value in [(addons, 'ROOT', self.root / 'addons'),
                                  (addons, 'STATE', str(self.root / 'addons.json')),
                                  (addons, 'DATA_DIR', str(self.root)),
                                  (skills_service, 'SKILLS_DIR', str(self.root / 'skills'))]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(settings, 'get_setting', side_effect=lambda key: self.values.get(key)); p.start(); self.addCleanup(p.stop)
        p = patch.object(settings, 'update_settings', side_effect=lambda **kw: self.values.update(kw)); p.start(); self.addCleanup(p.stop)

    def test_fresh_base_has_no_optional_tools_or_skill_seeding(self):
        addons.migrate()
        self.assertTrue(all(not row['installed'] for row in addons.catalog()))
        offered = {s.name for s in tool_registry.specs('codex', True)}
        self.assertTrue(offered.isdisjoint(addons.TOOLS))
        self.assertTrue(set(skills_service.seed_default_skills()).isdisjoint(addons.SKILLS))
        for name in addons.MODULES:
            with self.assertRaises(ValueError): addons.module(name)
        self.assertNotIn('roblox', custom_tabs.template_slugs())
        result = asyncio.run(tool_registry.call('roblox_studio', {}, tool_registry.ToolContext(is_admin=True), 'codex'))
        self.assertIn('Install and enable', result)

    def test_independent_install_and_disable_blocks_model_and_direct_call(self):
        addons.change('blender', 'install')
        self.assertTrue(addons.enabled('blender')); self.assertFalse(addons.enabled('higgsfield'))
        self.assertTrue(skill_curator.model_visible('blender-creation'))
        creative = addons.module('creative_tools')
        self.assertEqual([c['id'] for c in creative.catalog('alice')], ['blender'])
        self.assertNotIn('roblox_studio', {s.name for s in tool_registry.specs('codex', True)})
        addons.change('blender', 'disable')
        self.assertFalse(skill_curator.model_visible('blender-creation'))
        with self.assertRaises(ValueError): creative.connect_blender('alice', 9876, 'token-that-is-long-enough')
        self.assertFalse(addons.tool_available('creative_tools'))
        addons.change('higgsfield', 'install')
        self.assertTrue(addons.tool_available('creative_tools'))
        self.assertFalse(addons.enabled('blender'))
        self.assertEqual([c['id'] for c in creative.catalog('alice')], ['higgsfield'])

    def test_reinstall_preserves_edited_skill_and_private_data(self):
        addons.change('roblox', 'install')
        path = Path(skills_service.SKILLS_DIR) / 'roblox-dev-skill' / 'SKILL.md'
        path.write_text('---\ndescription: My custom guide\n---\nMy changes', encoding='utf-8')
        data = self.root / 'tab-data' / 'roblox'; data.mkdir(parents=True)
        (data / 'projects.json').write_text('{"keep": true}')
        addons.change('roblox', 'remove')
        self.assertFalse(addons.enabled('roblox')); self.assertFalse(addons.catalog()[0]['installed'])
        self.assertFalse(skill_curator.model_visible('roblox-dev-skill'))
        addons.change('roblox', 'install')
        self.assertIn('My changes', path.read_text())
        self.assertEqual(json.loads((data / 'projects.json').read_text()), {'keep': True})
        self.assertIn('roblox', custom_tabs.template_slugs())

    def test_tampered_runtime_and_tab_refused(self):
        addons.change('roblox', 'install')
        path = addons.file('roblox', 'runtime/roblox_workspace.py')
        path.write_text('raise RuntimeError("must never execute")')
        with self.assertRaises(ValueError): addons.module('roblox_workspace')
        path = addons.file('roblox', 'tabs/roblox/routes.py'); path.write_text('# changed')
        self.assertFalse(addons.verify_tab('roblox'))
        self.assertNotIn('roblox', {name for name, mod in custom_tabs.discover()})
        for name in ['../core/addons.py', '/absolute', 'static/../../secret']:
            with self.assertRaises(ValueError): addons.file('roblox', name)

    def test_migration_adopts_explicit_setups_once_only(self):
        self.values['enabled_tab_templates'] = ['roblox']
        (self.root / 'creative-connections.json').write_text(json.dumps({'accounts': {'alice': {'token': 'encrypted'}}}))
        addons.migrate()
        self.assertTrue(addons.enabled('roblox')); self.assertTrue(addons.enabled('blender'))
        self.assertFalse(addons.enabled('higgsfield'))
        addons.change('roblox', 'remove'); addons.change('blender', 'disable')
        addons.migrate()
        self.assertFalse(addons.enabled('roblox')); self.assertFalse(addons.enabled('blender'))

    def test_auto_seeded_skills_do_not_activate_addons(self):
        self.values['seeded_skills'] = list(addons.SKILLS)
        addons.migrate()
        self.assertTrue(all(not row['installed'] for row in addons.catalog()))

    def test_roblox_routes_mount_disable_and_reenable_without_losing_data(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routes import addon_routes
        app = FastAPI(); app.include_router(addon_routes.router)
        app.dependency_overrides[addon_routes.require_user] = lambda: 'alice'
        app.dependency_overrides[addon_routes.require_admin] = lambda: 'alice'
        client = TestClient(app)
        self.assertEqual(client.get('/api/tab-roblox/projects').status_code, 404)
        installed = client.post('/api/addons/roblox', json={'action':'install'})
        self.assertEqual(installed.status_code, 200, installed.text)
        self.assertFalse(installed.json()['restart_required'])
        self.assertEqual(client.get('/api/tab-roblox/projects').status_code, 200)
        self.assertEqual(client.post('/api/addons/roblox', json={'action':'disable'}).status_code, 200)
        self.assertEqual(client.get('/api/tab-roblox/projects').status_code, 409)
        self.assertEqual(client.post('/api/addons/roblox', json={'action':'enable'}).status_code, 200)
        self.assertEqual(client.get('/api/tab-roblox/projects').status_code, 200)

    def test_busy_creative_operation_prevents_disable(self):
        addons.change('blender', 'install'); creative = addons.module('creative_tools')
        creative._busy.add(('alice', 'blender'))
        try:
            with self.assertRaises(ValueError): addons.change('blender', 'disable')
            self.assertTrue(addons.enabled('blender'))
        finally: creative._busy.discard(('alice', 'blender'))

    def test_api_denies_disabled_providers_and_requires_admin_for_install(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routes import addon_routes, creative_routes
        app = FastAPI(); app.include_router(addon_routes.router); app.include_router(creative_routes.router)
        app.dependency_overrides[addon_routes.require_user] = lambda: 'alice'
        client = TestClient(app)
        self.assertEqual(client.get('/api/creative').json(), [])
        self.assertEqual(client.get('/api/creative/blender/addon').status_code, 409)
        from core import middleware
        with patch.object(middleware, 'get_current_user', return_value='bob'), patch.object(middleware.auth_manager, 'is_admin', return_value=False):
            self.assertEqual(client.post('/api/addons/blender', json={'action': 'install'}).status_code, 403)
        app.dependency_overrides[addon_routes.require_admin] = lambda: 'alice'
        self.assertEqual(client.post('/api/addons/blender', json={'action': 'install'}).status_code, 200)
        self.assertEqual(client.get('/api/creative/blender/addon').status_code, 200)
        self.assertEqual(client.get('/api/addons/blender/files/runtime/creative_tools.py').status_code, 404)
        self.assertEqual(client.post('/api/addons/blender', json={'action': 'disable'}).status_code, 200)
        self.assertEqual(client.post('/api/creative/blender', json={'port':9876,'token':'long-pairing-token-12345'}).status_code, 409)


if __name__ == '__main__': unittest.main()
