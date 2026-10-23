"""Real chat turns and real stores with scripted providers; loopback only."""
import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix='bg-any-model-')
os.environ['JARVIS_DATA_DIR'] = fixture.name

from core import chat_tasks, helpers, model_endpoints, settings, tool_registry
from core.session_manager import session_manager
from services import background_tasks as bg, chat_service
from services.agent_service import agent_service
from services.task_service import task_service
from scripts.bg_model_server import ScriptedModelServer, demo_calls


class AnyModelTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Use the harness's guard, restoring every patched boundary afterwards.
        import httpx
        from scripts.bg_tasks_scripted import install_network_guard
        cls.guard = ExitStack()
        for obj, name in [(socket, 'getaddrinfo'), (socket, 'create_connection'),
                          (socket.socket, 'connect'), (socket.socket, 'connect_ex'),
                          (httpx.HTTPTransport, 'handle_request'),
                          (httpx.AsyncHTTPTransport, 'handle_async_request')]:
            cls.guard.enter_context(patch.object(obj, name, getattr(obj, name)))
        install_network_guard()
        cls.addClassCleanup(cls.guard.close)

    async def asyncSetUp(self):
        self.server = ScriptedModelServer().start()
        self.addAsyncCleanup(asyncio.to_thread, self.server.close)
        self.sid = session_manager.create_session()['id']
        self.addAsyncCleanup(chat_service.close_session_brain, self.sid)
        self.helper = model_endpoints.create_endpoint('Held helper', self.server.base_url,
                                                     'scripted-helper', kind='local')
        settings.update_settings(helper_endpoint_id=self.helper['id'], vault_dir=fixture.name)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(patch('core.mcp_bridge.discover', AsyncMock(return_value=({}, None))))
        self.patches.enter_context(patch.object(chat_service, '_reply_hook'))
        self.patches.enter_context(patch.object(chat_service, '_record_turn_telemetry'))
        self.patches.enter_context(patch.object(chat_service, '_compact_if_nearly_full', AsyncMock()))
        self.patches.enter_context(patch.object(helpers, 'WAIT_SECONDS', .25))
        self.agent = agent_service.create('Reviewer ' + self.sid, endpoint_id=self.helper['id'])

    def endpoint(self, kind, **kwargs):
        endpoint = model_endpoints.create_endpoint('Scripted', self.server.base_url, 'scripted', kind=kind, **kwargs)
        session_manager.set_model_endpoint(self.sid, endpoint['id'])
        return endpoint

    async def turn(self, admin=False):
        return [chunk async for chunk in chat_service.stream_message(self.sid, 'Start jobs', is_admin=admin)]

    async def until(self, condition):
        async with asyncio.timeout(8):
            while not condition():
                await asyncio.sleep(.01)

    def items(self):
        return bg.list_items(self.sid)

    async def finish_helpers(self):
        self.server.release.set()
        await self.until(lambda: all(r['status'] == 'done' for r in helpers._rows('parent = ?', ('chat:' + self.sid,))))
        items = self.items()
        self.assertTrue(any(i['kind'] == 'helper' and i['status'] == 'done' for i in items))
        self.assertFalse(any(i['kind'] == 'helper' and i['status'] in ('running', 'queued', 'waiting') for i in items))
        ctx = tool_registry.ToolContext(session_id=self.sid)
        self.assertIn('Finished scripted research.', helpers.results_text(None, ctx))
        self.assertTrue(any(n['kind'] == 'helper' for n in chat_tasks.notes(self.sid)))

    def finish_other_work(self):
        for item in self.items():
            if item['id'].startswith('card:'):
                ident = item['id'].split(':', 1)[1]
                task_service.claim_next_card(card_id=ident)
                task_service.finish_card(ident, 'Scripted card finished')
            elif item['kind'] == 'scheduled':
                ident = item['id'].split(':', 1)[1]
                task_service.record_run(ident, 'Scripted schedule finished')
                task_service.update_task(ident, enabled=False)
        self.assertFalse(any(i['status'] in ('running', 'queued', 'waiting', 'scheduled') for i in self.items()))
        self.assertEqual({i['id'] for i in self.items()}, {n['id'] for n in chat_tasks.notes(self.sid)})

    async def external_chat(self, kind, agent_chat=False):
        self.endpoint(kind)
        self.server.calls = demo_calls(self.agent['id'] if kind == 'api' and not agent_chat else None)
        if agent_chat:
            source = agent_service.create('Coordinator ' + self.sid, endpoint_id=session_manager.get_session(self.sid)['model_endpoint_id'])
            agent_service.update(source['id'], peers=[self.agent['id']])
            agent_service.make_agent_chat(self.sid, agent_service.get(source['id']))
            self.server.calls.append(('agent_assign', {'agent': self.agent['id'], 'work': 'Inspect coverage'}))
        self.server.calls.append(('create_task', {'name': 'Board work', 'prompt': 'Inspect', 'schedule_kind': 'card', 'status': 'ready'}))
        work = asyncio.create_task(self.turn(admin=True))
        self.addAsyncCleanup(self.cancel_work, work)
        await self.until(lambda: self.server.helper_started.is_set() or work.done())
        if work.done():
            self.fail(f'Chat ended before delegation: {await work}; requests={self.server.requests}; errors={self.server.errors}')
        self.assertFalse(work.done(), 'The helper must be visible while delegate is waiting')
        self.assertEqual(len([i for i in self.items() if i['kind'] == 'helper' and i['status'] == 'running']), 2)
        self.assertFalse(bg.list_items(session_manager.create_session()['id']), 'Another chat cannot inherit these items')
        chunks = await asyncio.wait_for(work, 8)
        self.assertIn('Started the helpers.', ''.join(c for c in chunks if isinstance(c, str)))
        self.assertEqual(helpers.helper_endpoint()['id'], self.helper['id'])
        self.assertTrue(all(r['endpoint_id'] == self.helper['id'] for r in helpers._rows('parent = ?', ('chat:' + self.sid,))))
        self.assertTrue(any(i['kind'] == 'scheduled' for i in self.items()))
        cards = [c for c in task_service.list_tasks() if c.get('origin_session_id') == self.sid]
        self.assertTrue(any(c['schedule_kind'] == 'once' for c in cards))
        self.assertTrue(any(c['schedule_kind'] == 'card' for c in cards))
        if agent_chat or kind == 'api':
            self.assertTrue(any((c.get('requester') or {}).get('session_id') == self.sid for c in task_service.list_tasks()))
        if kind == 'local':
            self.assertTrue(any(any(m.get('name') == 'kairos_tool_call' for m in
                                    [c['function'] for msg in r['messages'] for c in msg.get('tool_calls', [])])
                                for r in self.server.requests if r['model'] == 'scripted'))
        await self.finish_helpers()
        self.finish_other_work()
        self.assertFalse(self.server.errors)

    async def cancel_work(self, work):
        if not work.done():
            work.cancel()
        await asyncio.gather(work, return_exceptions=True)
        helpers.stop_parent('chat:' + self.sid)
        await asyncio.gather(*helpers._active.get('chat:' + self.sid, ()), return_exceptions=True)

    async def test_api_delegate_schedule_handoff(self):
        await self.external_chat('api')

    async def test_local_delegate_schedule(self):
        await self.external_chat('local')

    async def test_api_agent_assignment(self):
        await self.external_chat('api', agent_chat=True)

    async def test_local_agent_assignment(self):
        await self.external_chat('local', agent_chat=True)

    async def test_claude_chat_hive_mind_delegate(self):
        from core.brain import Brain
        from core.hive_mind_server import get_hive_mind_server
        from claude_agent_sdk import AssistantMessage, TextBlock, ResultMessage, ClaudeAgentOptions
        self.endpoint('claude_cli')
        fixture_test = self

        class Client:
            def __init__(self, **kwargs):
                pass

            async def connect(self):
                pass

            async def query(self, prompt):
                pass

            async def receive_response(self):
                server = get_hive_mind_server(fixture_test.sid, is_admin=True, only=frozenset({'delegate'}))
                # Invoke the actual SDK-registered handler, including its context.
                from mcp import types
                instance = server['instance']
                params = types.CallToolRequestParams(name='delegate', arguments={'jobs': [{'goal': 'Inspect Claude helper'}]})
                if hasattr(instance, '_request_handlers'):  # MCP 2
                    answer = await instance._request_handlers['tools/call'].handler(None, params)
                else:  # MCP 1
                    answer = (await instance.request_handlers[types.CallToolRequest](
                        types.CallToolRequest(method='tools/call', params=params))).root
                fixture_test.assertFalse(answer.model_dump(by_alias=True).get('isError', False))
                yield AssistantMessage([TextBlock('Started the helpers.')], 'scripted')
                yield ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False,
                                    num_turns=1, session_id='scripted', usage={})

            async def disconnect(self):
                pass

        self.patches.enter_context(patch('core.brain.ClaudeSDKClient', Client))
        self.patches.enter_context(patch.object(Brain, '_options', return_value=ClaudeAgentOptions()))
        work = asyncio.create_task(self.turn(admin=True))
        self.addAsyncCleanup(self.cancel_work, work)
        await self.until(lambda: self.server.helper_started.is_set() or work.done())
        if work.done():
            await work
        self.assertTrue(any(i['kind'] == 'helper' and i['status'] == 'running' for i in self.items()))
        await asyncio.wait_for(work, 5)
        await self.finish_helpers()

    async def test_codex_chat_spawn_and_token_tools(self):
        from core.codex_brain import CodexBrain
        from core import tool_access
        from routes.tool_routes import call_tool
        from starlette.requests import Request
        self.endpoint('codex_cli')
        finish = asyncio.Event()
        tokens = []

        async def spawn(*args, **kwargs):
            token = kwargs['env']['JARVIS_TOOL_TOKEN']
            tokens.append(token)
            self.assertEqual(tool_access.resolve(token).session_id, self.sid)
            request = Request({'type': 'http', 'client': ('127.0.0.1', 12345), 'headers':
                               [(b'x-jarvis-tool-token', token.encode())]})
            for name, arguments in demo_calls(self.agent['id']):
                answer = await call_tool(name, request, {'arguments': arguments})
                self.assertFalse(answer['result'].startswith(('Not run', 'Tool error')), answer)
            reader = asyncio.StreamReader()
            def feed(record):
                reader.feed_data((json.dumps(record) + '\n').encode())
            feed({'type': 'item.started', 'item': {'id': 'spawn', 'type': 'collab_tool_call',
                  'tool': 'spawn_agent', 'receiver_thread_ids': ['worker'], 'prompt': 'Inspect'}})
            async def complete():
                await finish.wait()
                feed({'type': 'item.completed', 'item': {'id': 'wait', 'type': 'collab_tool_call',
                      'tool': 'wait', 'receiver_thread_ids': ['worker'], 'agents_states': {'worker': {'status': 'completed'}}}})
                feed({'type': 'turn.completed', 'usage': {}})
                reader.feed_eof()
            producer = asyncio.create_task(complete())
            self.addAsyncCleanup(self.cancel_work, producer)
            stderr = asyncio.StreamReader(); stderr.feed_eof()
            return SimpleNamespace(stdout=reader, stderr=stderr, stdin=Mock(), returncode=0, wait=AsyncMock(return_value=0))

        self.patches.enter_context(patch.object(CodexBrain, '_codex_path', return_value='scripted-codex'))
        self.patches.enter_context(patch('core.codex_brain.asyncio.create_subprocess_exec', side_effect=spawn))
        self.patches.enter_context(patch('core.codex_brain._kill_process_tree', AsyncMock(return_value=True)))
        work = asyncio.create_task(self.turn(admin=True))
        self.addAsyncCleanup(self.cancel_work, work)
        await self.until(lambda: any(i['id'] == 'codex:worker' for i in self.items()) or work.done())
        if work.done():
            await work
        self.assertTrue(any(i['source'] == 'codex' and i['status'] == 'running' for i in self.items()))
        self.assertTrue(any(i['kind'] == 'helper' and i['status'] == 'running' for i in self.items()))
        finish.set()
        await asyncio.wait_for(work, 5)
        self.assertIsNone(tool_access.resolve(tokens[0]))
        await self.finish_helpers()
        self.finish_other_work()

    async def test_scheduled_only_watcher_broadcasts_before_first_run(self):
        self.endpoint('api')
        self.server.calls = [demo_calls()[1]]
        await self.turn()
        with patch.object(bg, '_broadcast') as broadcast, patch('services.background_tasks.asyncio.sleep', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await bg._watch()
        self.assertTrue(any(call.args[0] == self.sid for call in broadcast.call_args_list))
        self.finish_other_work()

    async def test_api_and_local_computer_chat_owner(self):
        from core.computer import manager
        settings.update_settings(computer_use={'enabled': True, 'allow_non_admins': True})
        for kind in ('api', 'local'):
            with self.subTest(kind=kind):
                self.endpoint(kind)
                self.server.calls = [('computer', {'action': 'open', 'url': self.server.base_url})]
                computers = []
                async def act(owner, action, arguments, ctx):
                    self.assertEqual(owner, 'chat:' + self.sid)
                    computers.append({'owner': owner, 'started_at': time.time(), 'url': arguments['url'], 'steps': []})
                    return {'text': 'Opened scripted browser', 'images': []}
                with patch.object(manager, 'act', side_effect=act), patch.object(manager, 'running', side_effect=lambda: computers):
                    await self.turn()
                    self.assertTrue(any(i['kind'] == 'computer' and i['status'] == 'running' for i in self.items()))
                    computers.clear()
                    self.assertFalse(any(i['kind'] == 'computer' and i['status'] == 'running' for i in self.items()))
                    self.assertTrue(any(n['kind'] == 'computer' for n in chat_tasks.notes(self.sid)))
                await chat_service.close_session_brain(self.sid)
        settings.update_settings(computer_use={'enabled': False})

    async def test_registry_surface_and_principal_gates(self):
        for surface in ('claude', 'codex', 'openai'):
            names = lambda **kw: {s.name for s in tool_registry.specs(surface, **kw)}
            self.assertTrue({'delegate', 'helper_results', 'create_task', 'computer'} <= names())
            self.assertNotIn('hand_to_agent', names())
            self.assertIn('hand_to_agent', names(is_admin=True))
            self.assertNotIn('agent_assign', names())
            self.assertIn('agent_assign', names(agent=True))
            self.assertNotIn('delegate', names(helper=True))
            self.assertNotIn('delegate', names(read_only=True))
            self.assertEqual('run_code' in names(), surface != 'codex')
            self.assertEqual('run_shell' in names(is_admin=True), surface == 'openai')


class ScriptedHarnessTests(unittest.TestCase):
    def test_api_and_local_harness_live_routes(self):
        code = '''
import asyncio, sys
from unittest.mock import patch
import httpx
from scripts import bg_tasks_scripted
async def check(app):
    from core.session_manager import session_manager
    from services import chat_live
    async with app.router.lifespan_context(app):
        sid = session_manager.list_sessions()[0]['id']
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8457') as client:
            response = await client.post('/api/chat/live', json={'session_id': sid, 'message': 'Start the jobs'})
            assert response.status_code == 200, response.text
            async with asyncio.timeout(15):
                while True:
                    response = await client.get('/api/chat/background/' + sid)
                    assert response.status_code == 200, response.text
                    items = response.json()['items']
                    if sum(i['kind'] == 'helper' and i['status'] == 'running' for i in items) == 2 and any(i['kind'] == 'scheduled' for i in items):
                        break
                    await asyncio.sleep(.02)
            await asyncio.wait_for(chat_live._tasks[sid], 5)
            items = (await client.get('/api/chat/background/' + sid)).json()['items']
            if sys.argv[-1] == 'api':
                assert any(i['kind'] == 'agent' for i in items), items
            async with asyncio.timeout(15):
                while True:
                    data = (await client.get('/api/chat/background/' + sid)).json()
                    if sum(i['kind'] == 'helper' and i['status'] == 'done' for i in data['items']) == 2:
                        assert len(data['notes']) >= 2, data
                        break
                    await asyncio.sleep(.02)
            print('HARNESS_PASS', sys.argv[-1])
with patch('uvicorn.run', side_effect=lambda app, **kw: asyncio.run(check(app))):
    bg_tasks_scripted.main()
'''
        for surface in ('api', 'local'):
            with self.subTest(surface=surface):
                process = subprocess.run([sys.executable, '-c', code, '--port', '8457', '--scale', '.1', '--surface', surface],
                                         capture_output=True, text=True, timeout=45)
                self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
                self.assertIn('HARNESS_PASS ' + surface, process.stdout)


def tearDownModule():
    fixture.cleanup()


if __name__ == '__main__':
    unittest.main()
