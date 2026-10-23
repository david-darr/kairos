import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
native_mkdir = os.mkdir
with patch('tempfile._os.mkdir', side_effect=lambda path, mode=0o777: native_mkdir(path, 0o777)):
    environment = tempfile.TemporaryDirectory(prefix='ask-user-', dir=Path(__file__).resolve().parents[1], ignore_cleanup_errors=True)
os.environ['JARVIS_DATA_DIR'] = environment.name
from core import permissions, mobile_activity
from core.brain import Brain
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ResultMessage
from routes import permission_routes
from core.middleware import require_user
from fastapi import FastAPI
import httpx

RAW = [{'question': 'Which color?', 'header': 'Color', 'options': [{'label': 'Red'}, {'label': 'Green'}]}]
QUESTIONS = permissions.normalize_questions(RAW)

class AskTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        permissions._pending.clear()
        permissions._channels.clear()
        self.storage = patch.object(permissions, 'PERMISSIONS_FILE', str(Path(environment.name) / 'permissions.json'))
        self.storage.start()

    def tearDown(self):
        self.storage.stop()

    async def asking(self, brain=None, raw=RAW):
        brain = brain or Brain(session_id='test', is_admin=True)
        queue = permissions.open_channel(brain.surface)
        task = asyncio.create_task(brain._permission('AskUserQuestion', {'questions': raw}, SimpleNamespace(suggestions=[])))
        request = await asyncio.wait_for(queue.get(), 3)
        self.addAsyncCleanup(self.cleanup_task, task, brain.surface)
        return task, request

    async def cleanup_task(self, task, surface):
        permissions.close_channel(surface)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_auto_and_base_use_question_broker(self):
        for mode in ('auto', 'base'):
            with patch('core.session_manager.session_manager.get_session', return_value={'permission_mode': mode}):
                task, request = await self.asking()
                self.assertEqual(request['kind'], 'question')
                self.assertEqual(request['questions'], QUESTIONS)
                self.assertEqual(request['choices'], [])
                self.assertEqual(request['arguments'], {})
                self.assertFalse(permissions.answer(request['id'], 'once', 'alice'))
                self.assertTrue(permissions.waiting('chat:test'))
                self.assertIsNone(permissions.respond(request['id'], answers={'Which color?': 'Green'}, skip=False, user='alice'))
                result = await task
                self.assertIsInstance(result, PermissionResultAllow)
                self.assertEqual(result.updated_input['answers'], {'Which color?': 'Green'})

    async def test_skip_close_and_timeout(self):
        for action in ('skip', 'close'):
            task, request = await self.asking()
            if action == 'skip':
                permissions.respond(request['id'], answers=None, skip=True, user='alice')
            else:
                permissions.close_channel('chat:test')
            result = await task
            self.assertIsInstance(result, PermissionResultDeny)
            self.assertFalse(result.interrupt)
            self.assertIn('skipped', result.message)
        ask = permissions.ask
        async def short(**kwargs):
            return await ask(**kwargs, timeout=.01)
        permissions.open_channel('chat:test')
        with patch.object(permissions, 'ask', short):
            result = await Brain(session_id='test')._ask_person({'questions': RAW})
        self.assertIn('Nobody answered', result.message)

    async def test_unattended_surfaces_and_read_only(self):
        for brain, expected in ((Brain(agent_id='a'), 'agent_ask'), (Brain(), 'Nobody is here')):
            result = await brain._ask_person({'questions': RAW})
            self.assertIn(expected, result.message)
            self.assertFalse(result.interrupt)
            self.assertFalse(permissions._pending)
        brain = Brain(session_id='test', read_only=True)
        self.assertTrue(brain._plan_tool('AskUserQuestion'))
        task, request = await self.asking(brain)
        permissions.respond(request['id'], answers=None, skip=True, user='alice')
        await task

    async def test_tool_config_never_preapproves_questions(self):
        from core import brain as module
        with patch.object(module.settings_store, 'get_setting', side_effect=lambda name: ['AskUserQuestion'] if name == 'extra_allowed_tools' else None):
            self.assertNotIn('AskUserQuestion', Brain(session_id='test', is_admin=True)._tool_config()[1])

    async def test_invalid_answers_do_not_resolve(self):
        task, request = await self.asking(raw=RAW + [{'question': 'Widgets?', 'multiSelect': True, 'options': [{'label': 'Tasks'}]}])
        good = {'Which color?': 'Green', 'Widgets?': ['Tasks']}
        bad = [{}, {'wrong': 'x'}, {'Which color?': 'Green'}, {**good, 'extra': 'x'},
               {**good, 'Which color?': ''}, {**good, 'Which color?': 'x'*4001},
               {**good, 'Which color?': ['Red']}, {**good, 'Widgets?': ['a','b','c']},
               {**good, 'Widgets?': ['Tasks',' Tasks ']}]
        for answers in bad:
            self.assertIsNotNone(permissions.respond(request['id'], answers=answers, skip=False, user='alice'))
            self.assertIsNotNone(permissions.pending_request(request['id']))
        value = {**good, 'Which color?': '<b>answer</b>'}
        self.assertIsNone(permissions.respond(request['id'], answers=value, skip=False, user='alice'))
        self.assertEqual((await task).updated_input['answers'], value)
        self.assertNotIn('<b>', json.dumps(permissions.audit()))

    def test_normalization_rejects_invalid_shapes_and_keeps_markup(self):
        for raw in ([], RAW*5, RAW*2, [{'question':'Q','options':[{'label':str(i)} for i in range(9)]}],
                    [{'question':'Q','options':[{'label':'x'},{'label':'x'}]}], [{'question':'Q','options':[{'label':42}]}]):
            self.assertIsNone(permissions.normalize_questions(raw))
        self.assertEqual(permissions.normalize_questions([{'question':'<b>Q</b>','options':[{'label':'<script>x</script>'}]}])[0]['question'], '<b>Q</b>')

    async def test_route_owner_only_and_stale(self):
        from app import app
        user = ['alice']
        overrides = dict(app.dependency_overrides)
        self.addCleanup(lambda: (app.dependency_overrides.clear(), app.dependency_overrides.update(overrides)))
        app.dependency_overrides[require_user] = lambda: user[0]
        task, request = await self.asking()
        with patch.object(permission_routes.chat_live.chat_service.session_manager, 'get_session', return_value={'owner_user':'alice'}), patch('core.auth.auth_manager.is_admin', side_effect=lambda name: name == 'admin'):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                for outsider in ('bob', 'admin'):
                    user[0] = outsider
                    self.assertEqual((await client.post(f"/api/permissions/{request['id']}/respond", json={'skip':True})).status_code, 404)
                    self.assertIsNotNone(permissions.pending_request(request['id']))
                user[0] = 'alice'
                self.assertEqual((await client.post(f"/api/permissions/{request['id']}/answer", json={'choice':'once'})).status_code, 409)
                self.assertEqual((await client.post('/api/permissions/stale/respond', json={'skip':True})).status_code, 404)
                self.assertEqual((await client.post(f"/api/permissions/{request['id']}/respond", json={'answers':{'Which color?':'Red'}})).status_code, 200)
        await task

    async def test_invalid_question_call_is_denied_without_prompt(self):
        result = await Brain(session_id='test')._permission('AskUserQuestion', {'questions': []}, SimpleNamespace())
        self.assertIsInstance(result, PermissionResultDeny)
        self.assertFalse(result.interrupt)
        self.assertFalse(permissions._pending)

    async def test_silence_clock_waits_without_cancelling_stream(self):
        class Client:
            query = AsyncMock()
            async def receive_response(self):
                await asyncio.sleep(.6)
                yield ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id='sdk')
        for waiting in (True, False):
            brain = Brain(session_id='test')
            brain._client = Client()
            with patch('core.brain.TURN_MESSAGE_TIMEOUT_SECONDS', .2), patch.object(permissions, 'waiting', return_value=waiting):
                if waiting:
                    self.assertTrue([event async for event in brain.events('hello')])
                else:
                    with self.assertRaisesRegex(RuntimeError, 'timed out'):
                        _ = [event async for event in brain.events('hello')]

    def test_question_push_contains_no_question_text(self):
        from contextlib import contextmanager
        class DB:
            def __init__(self): self.payloads = []
            def execute(self, sql, args=()):
                if sql.startswith('SELECT * FROM activity'):
                    return SimpleNamespace(fetchone=lambda: {'snapshot':'{}','session_id':'test','owner':'alice'})
                if sql.startswith('SELECT * FROM devices'):
                    return SimpleNamespace(fetchall=lambda: [{'id':'d','preferences':'{"permission":true}'}])
                self.payloads.append(args)
        db = DB()
        @contextmanager
        def database(): yield db
        with patch.object(mobile_activity, 'database', database):
            mobile_activity.enqueue('run', 'permission', {'id':'q', 'kind':'question','questions':RAW,'expires_at':9999999999})
        payload = json.loads(db.payloads[0][5])
        self.assertEqual(payload['body'], 'A chat is waiting for your answer. Tap to respond.')
        self.assertNotIn('Which color?', json.dumps(payload))

def tearDownModule():
    from core import session_manager_store
    session_manager_store.close()
    environment.cleanup()


if __name__ == '__main__':
    unittest.main()
