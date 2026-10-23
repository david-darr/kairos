"""Scheduled-run ownership and CRM receipts, with simulated agents and reader."""
import asyncio
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from test_crm import CRMService, settings, tab_api
from kairos_tabs.crm import completion, hooks, work
from core import runs, task_scheduler, task_scope, tool_access, tool_registry, tab_hooks
from core.external_brain import ExternalBrain
from core import hive_mind_server
from core.session_manager import session_manager
from services.task_service import task_service
from services.agent_service import agent_service
from routes import tool_routes, agent_routes, task_routes
from fastapi import FastAPI
from fastapi.testclient import TestClient


class RoutineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings.update_settings(enabled_tab_templates=["crm"])
        self.store = CRMService('routine-' + self._testMethodName + '.json')
        self.store.configure('alice', {'endpoint_id': 'reader'})
        self.task = self.store.create_task('alice', {'title': 'Create a soccer curriculum PDF'})
        self.foreign = self.store.create_task('bob', {'title': self.task['title'], 'notes': 'PRIVATE BOB'})
        self.agent = agent_service.create('Routine fixture ' + self._testMethodName)
        self.routine = task_service.create_task('Daily CRM work', 'Complete the soccer curriculum PDF task.',
            'daily', run_time='09:30', agent_id=self.agent['id'], owner_user='alice', report_when='always')
        self.reply = 'Created the soccer curriculum PDF: soccer-curriculum.pdf'
        self.actions = True
        self.failure = False
        self.gate = None
        self.on_result = None
        self.entered = asyncio.Event()
        self.model = AsyncMock(side_effect=lambda *a, **kw: self.decision())
        app = FastAPI(); app.include_router(tool_routes.router)
        self.client = TestClient(app, client=('127.0.0.1', 50000))
        for change in (patch('core.auth.auth_enabled', return_value=True),
                       patch.object(hooks, 'crm_service', self.store), patch.object(work, 'crm_service', self.store),
                       patch.object(completion, 'crm_service', self.store),
                       patch.object(completion, 'start'), patch.object(completion, '_wake', asyncio.Event()),
                       patch.object(tab_api, 'complete', self.model),
                       patch.object(tab_api, 'model_context_size', return_value=16384),
                       patch.object(task_scheduler, '_task_brain', side_effect=lambda task: self.adapter()),
                       patch.object(agent_service, 'notify')):
            change.start(); self.addCleanup(change.stop)

    def decision(self):
        return json.dumps({'completed': [{'task_id': self.task['id'], 'actor': 'assistant',
            'quote': self.reply, 'certain': True, 'requires_action': True}]})

    def adapter(self):
        test = self
        class Adapter:
            async def connect(self):
                # Local/API context and Codex's HTTP token carry the same owner.
                brain = ExternalBrain('http://fixture', 'fixture', None, agent_id=test.agent['id'])
                assert brain._context().owner_user == 'alice'
            async def disconnect(self): pass
            async def events(self, prompt, stream=False):
                token = tool_access.issue(None, False, test.agent['id'])
                try:
                    found = test.client.post('/api/tools/list_tab_tasks', json={'arguments': {'tab': 'crm'}},
                        headers={'X-JARVIS-Tool-Token': token}).json()['result']
                    assert test.task['id'] in found, found
                    assert test.foreign['id'] not in found, found
                    refused = test.client.post('/api/tools/read_tab_task',
                        json={'arguments': {'tab': 'crm', 'task_id': test.foreign['id'], 'owner_user': 'bob'}},
                        headers={'X-JARVIS-Tool-Token': token}).json()['result']
                    assert 'PRIVATE BOB' not in refused
                finally:
                    tool_access.revoke(token)
                test.entered.set()
                if test.gate:
                    await test.gate.wait()
                if test.failure:
                    raise RuntimeError('simulated agent failure')
                if test.actions:
                    yield runs.tool_started('file1', 'write_file', {'path': 'soccer-curriculum.pdf'})
                    yield runs.tool_finished('file1', True, 'Created soccer-curriculum.pdf with all eight sessions')
                if test.on_result:
                    test.on_result()
                yield runs.text(test.reply)
                yield runs.result(True)
        return Adapter()

    async def run_routine(self):
        await task_scheduler.start_run(self.routine, 'manual')
        await completion.process()

    async def test_run_now_lookup_actions_receipt_and_completion_end_to_end(self):
        await self.run_routine()
        saved = self.store.task('alice', self.task['id'])
        self.assertEqual(saved['status'], 'done')
        self.assertEqual(saved['completion']['kind'], 'routine')
        self.assertEqual(saved['completion']['routine_id'], self.routine['id'])
        self.assertEqual(saved['completion']['agent_id'], self.agent['id'])
        self.assertEqual(self.store.task('bob', self.foreign['id'])['status'], 'active')
        await completion.process()
        self.model.assert_awaited_once()

    async def test_partial_result_is_checked_but_left_open(self):
        self.reply = 'Outlined the soccer curriculum; the PDF still needs creating.'
        self.model.side_effect = None; self.model.return_value = '{"completed": []}'
        await self.run_routine()
        self.model.assert_awaited_once()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'active')

    async def test_daily_scheduled_occurrence_completes_and_advances_once(self):
        self.routine['next_run_at'] = datetime.now(timezone.utc).isoformat()
        await task_scheduler.start_run(self.routine, 'schedule')
        await completion.process()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'done')
        self.assertEqual(len(task_service.list_runs(self.routine['id'])), 1)
        self.assertFalse(await task_scheduler.start_run(self.routine, 'schedule'))
        self.assertEqual(len(task_service.list_runs(self.routine['id'])), 1)

    async def test_claim_without_file_action_is_not_enough(self):
        self.actions = False
        await self.run_routine()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'active')

    async def test_failed_and_stopped_runs_never_submit_completion(self):
        self.failure = True
        await self.run_routine()
        self.model.assert_not_awaited()
        self.failure = False; self.gate = asyncio.Event(); self.entered.clear()
        pending = asyncio.create_task(task_scheduler.start_run(self.routine, 'manual'))
        await self.entered.wait()
        self.assertTrue(task_scheduler.stop_run(self.routine['id']))
        await pending
        await completion.process()
        self.model.assert_not_awaited()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'active')

    async def test_old_reports_in_request_are_not_user_completion_evidence(self):
        self.routine['prompt'] = 'I created the soccer curriculum PDF yesterday. Review current work.'
        self.reply = 'The soccer curriculum PDF still needs work.'
        self.model.side_effect = None
        self.model.return_value = json.dumps({'completed': [{'task_id': self.task['id'], 'actor': 'user',
            'quote': 'I created the soccer curriculum PDF yesterday.', 'certain': True, 'requires_action': False}]})
        await self.run_routine()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'active')
        payload = self.model.call_args.args[2]
        self.assertIn('work_request', payload)
        self.assertIn('"user_message": ""', payload)

    async def test_edit_reopen_or_disable_during_run_is_respected(self):
        def reopen():
            self.store.update_task('alice', self.task['id'], {'status': 'done'})
            self.store.update_task('alice', self.task['id'], {'status': 'active'})
        # Reopening while the classifier is judging prevents stale publication.
        async def judge(*a, **kw):
            reopen()
            return self.decision()
        self.model.side_effect = judge
        await self.run_routine()
        self.assertEqual(self.store.task('alice', self.task['id'])['status'], 'active')
        self.on_result = lambda: settings.update_settings(enabled_tab_templates=[])
        self.model.reset_mock()
        await self.run_routine()
        self.model.assert_not_awaited()

    async def test_scope_expires_for_inherited_async_children(self):
        child = None
        gate = asyncio.Event()
        async def check():
            await gate.wait()
            return task_scope.current_owner(self.agent['id'])
        with task_scope.bind(self.routine):
            self.assertEqual(task_scope.current_owner(self.agent['id']), 'alice')
            child = asyncio.create_task(check())
        gate.set()
        self.assertIsNone(await child)

    def test_legacy_ownerless_and_conflicting_owners_are_not_guessed(self):
        task = {'id': 'old', 'agent_id': self.agent['id']}
        self.assertIsNone(task_scope.owner_for(task))
        self.assertIsNone(task_scope.owner_for({**task, 'owner_user': 'alice', 'owner': 'bob'}))
        with task_scope.bind(task):
            token = tool_access.issue(None, True, self.agent['id'])
            try:
                self.assertIsNone(tool_access.resolve(token).owner_user)
            finally:
                tool_access.revoke(token)

    async def test_wrong_failed_or_foreign_run_receipts_are_not_forwarded(self):
        record = {'task_id': self.routine['id'], 'agent_id': self.agent['id'], 'surface': 'goal',
                  'outcome': 'finished', 'ended_at': 1}
        dispatch = AsyncMock()
        with task_scope.bind(self.routine), patch.object(tab_hooks, '_declared', dispatch), \
             patch('core.session_manager_store.get_run', return_value=record):
            for changed in ({'outcome': 'failed'}, {'outcome': 'stopped'}, {'task_id': 'foreign'},
                            {'agent_id': 'foreign'}, {'surface': 'chat'}):
                original = record.copy(); record.update(changed)
                await tab_hooks.emit_task_run(self.routine, 'run1', 'Work', self.reply)
                record.clear(); record.update(original)
            dispatch.assert_not_awaited()

    def test_existing_origin_owner_and_explicit_idle_adoption(self):
        session = session_manager.create_session('Owned chat', owner_user='alice')
        old = task_service.create_task('Old routine', 'Work', 'daily', run_time='09:30', agent_id=self.agent['id'],
                                       origin_session_id=session['id'])
        self.assertEqual(task_scope.owner_for(old), 'alice')
        task_service.bind_owner(old['id'], 'bob')
        self.assertEqual(old['owner_user'], 'alice')
        old2 = task_service.create_task('Old ownerless routine', 'Work', 'daily', run_time='09:30', agent_id=self.agent['id'])
        task_service.bind_owner(old2['id'], 'alice')
        self.assertEqual(old2['owner_user'], 'alice')
        task_service.bind_owner(old2['id'], 'bob')
        self.assertEqual(old2['owner_user'], 'alice')
        old3 = task_service.create_task('Running old routine', 'Work', 'daily', run_time='09:30', agent_id=self.agent['id'])
        old3['run_started_at'] = 1
        with self.assertRaises(ValueError):
            task_service.bind_owner(old3['id'], 'bob')

    def test_goal_route_stamps_authenticated_owner(self):
        app = FastAPI(); app.include_router(agent_routes.router)
        app.dependency_overrides[tab_api.require_admin] = lambda: 'alice'
        client = TestClient(app)
        result = client.post(f"/api/agents/{self.agent['id']}/goals", json={
            'name': 'Owner test', 'prompt': 'Review CRM', 'schedule_kind': 'daily', 'run_time': '09:30', 'owner_user': 'bob'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['owner_user'], 'alice')

    def test_claude_tool_server_captures_the_same_background_owner(self):
        captured = []
        original = hive_mind_server._handler
        def handler(name, ctx):
            captured.append(ctx)
            return original(name, ctx)
        with task_scope.bind(self.routine), patch.object(hive_mind_server, '_handler', side_effect=handler):
            hive_mind_server.get_hive_mind_server(agent_id=self.agent['id'])
        self.assertTrue(captured)
        self.assertTrue(all(ctx.owner_user == 'alice' for ctx in captured))


if __name__ == '__main__':
    unittest.main()
