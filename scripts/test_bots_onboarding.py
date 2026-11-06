import asyncio
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from test_data_support import TestDataDirectory
ENV = TestDataDirectory('kairos-onboarding-')
os.environ['JARVIS_DATA_DIR'] = ENV.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_admin, require_user
from services import bot_onboarding as onboarding
from routes.bot_onboarding_routes import router


class OnboardingTests(unittest.TestCase):
    def setUp(self):
        onboarding.file_path().unlink(missing_ok=True)
        self.app = FastAPI(); self.app.include_router(router)
        self.app.dependency_overrides[require_admin] = lambda: 'alice'; self.app.dependency_overrides[require_user] = lambda: 'alice'
        self.client = TestClient(self.app)

    def test_state_roundtrip_owner_and_validation(self):
        base = '/api/bot-onboarding'
        self.assertFalse(self.client.get(base).json()['welcome_seen'])
        self.assertEqual(self.client.patch(base, json={'welcome_seen': True, 'tour': {'step': 2}, 'hints': ['widget']}).status_code, 200)
        state = self.client.get(base).json()
        self.assertTrue(state['welcome_seen']); self.assertEqual(state['tour']['step'], 2)
        self.assertEqual(state['hints_seen'], ['widget'])
        self.assertFalse(onboarding.state('bob')['welcome_seen'])
        for body in ({'owner': 'bob'}, {'tour': {'step': 11}}, {'tour': {'done': 1}}, {'hints': ['../bad']}, {'notices': {'bad': {'dismissed': False, 'copy': 'bad'}}}):
            self.assertEqual(self.client.patch(base, json=body).status_code, 422)

    def test_hints_and_notices_never_recreated(self):
        onboarding.patch('alice', {'hints': ['widget', 'widget'], 'notices': {'local': {'dismissed': True}}})
        old = onboarding.state('alice')['notices']['local']
        onboarding.patch('alice', {'hints': ['widget'], 'notices': {'local': {'dismissed': False}}})
        now = onboarding.state('alice')
        self.assertEqual(now['notices']['local'], old)
        self.assertEqual(now['hints_seen'], ['widget'])

    def test_real_checks_and_recheck_limit(self):
        async def docker(): return {'available': True, 'image_ready': False}
        async def voices(): return {'voices': [{'id': 'x'}], 'models': ['local']}
        with patch('core.model_endpoints.list_endpoints', return_value=[{'kind': 'api', 'has_api_key': True}]), \
             patch('services.bot_workbench.docker_status', docker), patch('core.call_voices.catalog', voices), \
             patch.object(onboarding, 'connected_apps', return_value={'gmail': True, 'calendar': False}):
            result = self.client.get('/api/bot-onboarding/setup')
            self.assertEqual(result.status_code, 200)
            states = {r['id']: r['status'] for r in result.json()['checks']}
            self.assertEqual(states, {'model': 'ready', 'computer': 'needs_setup', 'gmail': 'ready', 'calendar': 'needs_setup', 'notifications': 'not_checked', 'voice': 'ready'})
            self.assertEqual(self.client.post('/api/bot-onboarding/setup/recheck').status_code, 429)
            later = onboarding.state('alice')['setup_checked_at'] + 11
            self.assertTrue(asyncio.run(onboarding.setup('alice', recheck=True, now=later))['checks'])

    def test_no_sign_in_no_state_access(self):
        app = FastAPI(); app.include_router(router)
        from fastapi import HTTPException
        def refused(): raise HTTPException(401)
        app.dependency_overrides[require_user] = refused
        self.assertEqual(TestClient(app).get('/api/bot-onboarding').status_code, 401)
        # Any signed-in person has their own onboarding state (phase 4b): the admin check is gone.
        app.dependency_overrides[require_user] = lambda: 'bea'
        self.assertEqual(TestClient(app).get('/api/bot-onboarding').status_code, 200)


if __name__ == '__main__': unittest.main()
