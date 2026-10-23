"""Scripted provider and bridge coverage for ask_user, with no real model."""
import asyncio
import copy
import json
import os
from pathlib import Path
import sys
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory

with patch('tempfile.tempdir', str(Path(__file__).resolve().parents[1])):
    environment = TestDataDirectory(prefix='.ask-any-model-')
os.environ['JARVIS_DATA_DIR'] = environment.name
import httpx
from core import permissions, tool_registry as registry, system_prompt, runs, tool_access
from core.session_manager import session_manager
from core.codex_brain import CodexBrain
from core import codex_questions, codex_brain
from core.external_brain import ExternalBrain
from core.providers import openai_compatible as provider
from services import chat_service
from mcp_servers import hive_mind_cli as cli
from scripts.scripted_openai_server import QUESTIONS

ANSWERS = {QUESTIONS[0]['question']: 'Tabs', QUESTIONS[1]['question']: ['Calendar', 'Tasks']}
LINE = 'When you need the person to choose or clarify before continuing, use ask_user rather than asking in plain text.'


class AskAnyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        permissions._pending.clear()
        permissions._channels.clear()
        self.storage = patch.object(permissions, 'PERMISSIONS_FILE', str(Path(environment.name) / 'permissions.json'))
        self.storage.start()
        self.addCleanup(self.storage.stop)

    def test_registry_and_prompts(self):
        for small in (False, True):
            self.assertIn('ask_user', [t['function']['name'] for t in registry.openai_tools(small_window=small)])
        self.assertIn('ask_user', [s.name for s in registry.specs(registry.CODEX, read_only=True)])
        self.assertNotIn('ask_user', [s.name for s in registry.specs(registry.CLAUDE)])
        self.assertNotIn('mcp__hive_mind__ask_user', registry.claude_preapproved())
        for surface in (registry.OPENAI, registry.CODEX):
            self.assertNotIn('ask_user', [s.name for s in registry.specs(surface, helper=True)])
        from core import hive_mind_server
        with patch.object(hive_mind_server, 'create_sdk_mcp_server', return_value={}) as create:
            hive_mind_server.get_hive_mind_server()
            self.assertNotIn('ask_user', [t.name for t in create.call_args.kwargs['tools']])
        codex = system_prompt.for_codex('python', 'cli', integration_ids=[])
        self.assertIn('ask_user --questions', codex)
        for prompt in (system_prompt.for_external(), codex):
            self.assertEqual(prompt.count(LINE), 1)
        for prompt in (system_prompt.for_claude(), system_prompt.HELPER_PROMPT):
            self.assertNotIn(LINE, prompt)

    async def scripted_turn(self, kind):
        endpoint = {'id': 'scripted', 'kind': kind, 'model': 'scripted-local'}
        with patch.object(chat_service.model_endpoints, 'resolve_runtime', return_value=('http://fixture/v1', 'scripted-local', None, 8192 if kind == 'local' else None)), patch.object(chat_service.model_catalog, 'context_capacity', return_value=None):
            brain = chat_service._build_brain(endpoint, 'scripted')
        self.assertIsInstance(brain, ExternalBrain)
        self.assertEqual(brain.small_window, kind == 'local')
        requests = []
        def reply(request):
            body = json.loads(request.content)
            requests.append(copy.deepcopy(body))
            if len(requests) == 1:
                questions = json.dumps(QUESTIONS) if kind == 'local' else QUESTIONS
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                    'id': 'ask', 'type': 'function', 'function': {'name': 'ask_user',
                    'arguments': json.dumps({'questions': questions})}}]}
            else:
                message = {'role': 'assistant', 'content': 'Thanks. ' + body['messages'][-1]['content']}
            return httpx.Response(200, json={'choices': [{'message': message}]})
        client_class = httpx.AsyncClient
        text = ''
        with patch.object(provider.httpx, 'AsyncClient', side_effect=lambda **kw: client_class(transport=httpx.MockTransport(reply), **kw)):
            async for item in chat_service._stream_with_permission_prompts('scripted', brain, 'Build a dashboard', runs.Tally()):
                if isinstance(item, dict) and 'permission' in item:
                    payload = item['permission']
                    self.assertEqual(payload['kind'], 'question')
                    self.assertEqual(payload['questions'], permissions.normalize_questions(QUESTIONS))
                    self.assertIsNone(permissions.respond(payload['id'], answers=ANSWERS, skip=False, user='alice'))
                elif isinstance(item, str):
                    text += item
        self.assertEqual(len(requests), 2)
        result = requests[1]['messages'][-1]
        self.assertEqual(result['role'], 'tool')
        self.assertIn('The person answered:', result['content'])
        self.assertIn('Calendar, Tasks', result['content'])
        self.assertIn('Tabs', result['content'])
        self.assertEqual(text, 'Thanks. ' + result['content'])

    async def test_api_turn(self):
        await self.scripted_turn('api')
        from scripts.scripted_openai_server import app
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            self.assertEqual((await client.get('/v1/models')).json()['data'][0]['id'], 'scripted-local')
            for stream in (False, True):
                for role in ('user', 'tool'):
                    response = await client.post('/v1/chat/completions', json={
                        'stream': stream, 'messages': [{'role': role, 'content': 'answer'}]})
                    if stream:
                        chunks = [json.loads(line[6:]) for line in response.text.splitlines()
                                  if line.startswith('data: ') and line != 'data: [DONE]']
                        message = chunks[0]['choices'][0]['delta']
                        self.assertIn('data: [DONE]', response.text)
                    else:
                        message = response.json()['choices'][0]['message']
                    if role == 'user':
                        self.assertEqual(json.loads(message['tool_calls'][0]['function']['arguments']), {'questions': QUESTIONS})
                    else:
                        self.assertEqual(message['content'], 'Thanks. answer')

    async def test_local_turn(self):
        await self.scripted_turn('local')

    async def test_refusals_and_helper(self):
        for status in ('skipped', 'timeout'):
            with patch.object(permissions, 'ask', AsyncMock(return_value=permissions.QuestionOutcome(status))):
                shared = await permissions.ask_person(surface='chat:t', agent_id=None, raw_questions=QUESTIONS, tool='ask_user')
                result = await registry.call('ask_user', {'questions': QUESTIONS}, registry.ToolContext(session_id='t', read_only=True), registry.OPENAI)
                self.assertEqual(result, shared.reason)
                self.assertIn('skipped' if status == 'skipped' else '30 minutes', result)
        queue = permissions.open_channel('chat:refusal')
        self.addCleanup(permissions.close_channel, 'chat:refusal')
        task = asyncio.create_task(registry.call('ask_user', {'questions': QUESTIONS},
                                   registry.ToolContext(session_id='refusal'), registry.OPENAI))
        request = await asyncio.wait_for(queue.get(), 3)
        permissions.respond(request['id'], answers=None, skip=True, user='alice')
        self.assertIn('The person skipped', await task)
        ask = permissions.ask
        async def short(**kwargs):
            return await ask(**kwargs, timeout=.001)
        with patch.object(permissions, 'ask', short):
            self.assertIn('Nobody answered within 30 minutes', await registry.call(
                'ask_user', {'questions': QUESTIONS}, registry.ToolContext(session_id='refusal'), registry.OPENAI))
        agent_queue = permissions.open_channel('agent:a')
        self.addCleanup(permissions.close_channel, 'agent:a')
        result = await registry.call('ask_user', {'questions': QUESTIONS}, registry.ToolContext(agent_id='a'), registry.CODEX)
        self.assertTrue(agent_queue.empty())
        self.assertIn('agent_ask', result)
        self.assertFalse(codex_questions._pending)
        self.assertFalse(permissions._pending)
        result = await registry.call('ask_user', {'questions': QUESTIONS}, registry.ToolContext(helper=True), registry.OPENAI)
        self.assertEqual(result, 'Unknown tool: ask_user')
        self.assertIn('needs 1 to 4', await registry.call('ask_user', {'questions': 'bad'}, registry.ToolContext(), registry.OPENAI))

    async def test_codex_route(self):
        from app import app
        token = tool_access.issue('route-test', False)
        self.addCleanup(tool_access.revoke, token)
        queue = permissions.open_channel('chat:route-test')
        self.addCleanup(permissions.close_channel, 'chat:route-test')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            started = asyncio.get_running_loop().time()
            task = asyncio.create_task(client.post('/api/tools/ask_user', json={'arguments': {'questions': QUESTIONS}}, headers={'X-JARVIS-Tool-Token': token}))
            try:
                payload = await asyncio.wait_for(queue.get(), 3)
                response = await asyncio.wait_for(task, .5)
                self.assertLess(asyncio.get_running_loop().time() - started, .8)
                self.assertIn("on screen", response.json()["result"])
                self.assertIn("route-test", codex_questions._pending)
                self.assertEqual(payload['questions'], permissions.normalize_questions(QUESTIONS))
                permissions.respond(payload['id'], answers=ANSWERS, skip=False, user='alice')
                response = await task
                self.assertEqual(response.status_code, 200)
                await codex_questions.clear('route-test')
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            tool_access.revoke(token)
            for invalid in ('wrong', token):
                response = await client.post('/api/tools/ask_user', json={}, headers={'X-JARVIS-Tool-Token': invalid})
                self.assertEqual(response.status_code, 403)

    def test_cli_arguments_and_timeout(self):
        spec = next(s for s in registry.specs(registry.CODEX) if s.name == 'ask_user')
        raw = json.dumps(QUESTIONS)
        parsed = cli.parser().parse_args(['ask_user', '--questions', raw])
        self.assertEqual(cli.arguments(spec, parsed), {'questions': QUESTIONS})
        filename = Path(environment.name) / 'questions.json'
        filename.write_text(raw, encoding='utf-8-sig')
        parsed = cli.parser().parse_args(['ask_user', '--questions_file', str(filename)])
        self.assertEqual(cli.arguments(spec, parsed), {'questions': QUESTIONS})
        if os.name == 'nt':
            # Stop PowerShell from stripping JSON quotes for native commands.
            probe = Path(environment.name) / 'parse_questions.py'
            probe.write_text("import sys, json\n"
                             + "sys.path.insert(0, " + repr(str(Path(__file__).resolve().parents[1])) + ")\n"
                             + "from mcp_servers import hive_mind_cli as cli\n"
                             + "from core import tool_registry as registry\n"
                             + "spec = next(s for s in registry.specs(registry.CODEX) if s.name == 'ask_user')\n"
                             + "print(json.dumps(cli.arguments(spec, cli.parser().parse_args())))\n", encoding='utf-8')
            command = ("& '" + sys.executable + "' '" + str(probe)
                       + "' --% ask_user --questions " + subprocess.list2cmdline([raw]))
            result = subprocess.run(['powershell', '-NoProfile', '-Command', command],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'questions': QUESTIONS})
        with patch.dict(os.environ, {'JARVIS_API_BASE': 'http://test/api', 'JARVIS_TOOL_TOKEN': 'token'}), patch.object(cli.httpx, 'post') as post:
            post.return_value.json.return_value = {'result': 'ok'}
            for name, timeout in (('ask_user', 180.0), ('list_notes', 180.0)):
                self.assertEqual(cli.call(name, {}), 'ok')
                self.assertEqual(post.call_args.kwargs['timeout'], timeout)

    async def codex_turn(self, action='answer', forge=False):
        sid = session_manager.create_session()['id']
        self.addCleanup(session_manager.delete_session, sid)
        brain = CodexBrain(session_id=sid)
        brain.forge = forge
        queue = permissions.open_channel('chat:' + sid)
        self.addCleanup(permissions.close_channel, 'chat:' + sid)
        launches, output = [], []
        first_reaped = asyncio.Event()
        registered = asyncio.Event()
        real_launch = asyncio.create_subprocess_exec
        real_kill = codex_brain._kill_process_tree
        first_tokens = []

        async def launch(*args, **kwargs):
            number = len(launches) + 1
            prompt_file = Path(environment.name) / f'prompt-{number}.txt'
            events = [
                {'type': 'thread.started', 'thread_id': 'same-thread'},
                {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Waiting.' if number == 1 else 'Resumed reply.'}},
                {'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 2}},
            ]
            if action == 'failure' and number == 1:
                events[-1] = {'type': 'turn.failed', 'error': {'message': 'fixture failure'}}
            code = ('import sys, pathlib\n'
                    + f'pathlib.Path({str(prompt_file)!r}).write_text(sys.stdin.read(), encoding="utf-8")\n'
                    + 'sys.stdout.write(' + repr(''.join(json.dumps(e) + '\n' for e in events)) + ')\n')
            if os.environ.get('ASK_CODEX_IN_MEMORY') == '1':
                # Optional sandbox verifier; the default launches a real child.
                stdout, stderr = asyncio.StreamReader(), asyncio.StreamReader()
                data = bytearray()
                def eof():
                    prompt_file.write_text(data.decode('utf-8'), encoding='utf-8')
                    stdout.feed_data(''.join(json.dumps(e) + '\n' for e in events).encode())
                    stdout.feed_eof()
                    stderr.feed_eof()
                proc = SimpleNamespace(stdin=SimpleNamespace(write=data.extend, write_eof=eof),
                                       stdout=stdout, stderr=stderr, returncode=0, wait=AsyncMock(return_value=0))
            else:
                proc = await real_launch(sys.executable, '-c', code, **kwargs)
            launches.append((args, kwargs, proc, prompt_file))
            first_tokens.append(kwargs['env']['JARVIS_TOOL_TOKEN'])
            return proc

        async def reap(proc):
            result = await real_kill(proc)
            if proc is launches[0][2]:
                first_reaped.set()
            return result

        async def consume():
            async for item in brain.events('Build a dashboard'):
                output.append(item)
                if item.kind == runs.EventKind.TEXT and item.data['text'] == 'Waiting.':
                    result = await registry.call('ask_user', {'questions': QUESTIONS},
                                                 registry.ToolContext(session_id=sid), registry.CODEX)
                    self.assertIn('on screen', result)
                    registered.set()

        with patch.object(CodexBrain, '_codex_path', return_value='codex'), patch.object(
                codex_brain.asyncio, 'create_subprocess_exec', side_effect=launch), patch.object(
                codex_brain, '_kill_process_tree', side_effect=reap):
            turn = asyncio.create_task(consume())
            try:
                ready = asyncio.create_task(registered.wait())
                await asyncio.wait([ready, turn], timeout=3, return_when=asyncio.FIRST_COMPLETED)
                if turn.done():
                    await turn
                await asyncio.wait_for(ready, 3)
                payload = await asyncio.wait_for(queue.get(), 3)
                await asyncio.wait_for(first_reaped.wait(), 3)
                self.assertEqual(len(launches), 1)
                self.assertIsNone(brain._proc)
                self.assertIsNone(tool_access.resolve(first_tokens[0]))
                if action == 'failure':
                    with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                        await turn
                elif action == 'stop':
                    self.assertTrue((await brain.cancel()).confirmed)
                    await asyncio.wait_for(turn, 3)
                elif action == 'cancel':
                    turn.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await turn
                else:
                    self.assertFalse(turn.done())
                    if action != 'timeout':
                        self.assertIsNone(permissions.respond(payload['id'], answers=ANSWERS,
                                                             skip=action == 'skip', user='alice'))
                    await asyncio.wait_for(turn, 3)
                    self.assertEqual(len(launches), 2)
                    self.assertIn('resume', launches[1][0])
                    self.assertIn('same-thread', launches[1][0])
                    prompt = launches[1][3].read_text(encoding='utf-8')
                    if action in ('skip', 'timeout'):
                        self.assertIn('got no answer', prompt)
                        self.assertIn('The person skipped this question' if action == 'skip' else 'Nobody answered within 30 minutes', prompt)
                    else:
                        self.assertIn('The person answered your ask_user question:', prompt)
                        self.assertIn('Calendar, Tasks', prompt)
                        self.assertIn('Tabs', prompt)
                    self.assertIn('Resumed reply.', ''.join(e.data['text'] for e in output if e.kind == runs.EventKind.TEXT))
                    self.assertNotEqual(*first_tokens)
                    self.assertEqual(sum(e.kind == runs.EventKind.RESULT for e in output), 1)
                    self.assertEqual(sum(e.kind == runs.EventKind.USAGE for e in output), 2)
                self.assertEqual(await asyncio.wait_for(queue.get(), 3), {'permission_closed': payload['id']})
                self.assertFalse(codex_questions._pending)
                self.assertFalse(codex_questions._owned)
                self.assertFalse(permissions._pending)
                if action in ('stop', 'cancel', 'failure'):
                    self.assertEqual(len(launches), 1)
            finally:
                turn.cancel()
                await asyncio.gather(turn, return_exceptions=True)
                await codex_questions.clear(sid)

    async def test_codex_answer_resumes(self):
        await self.codex_turn()

    async def test_codex_forge_answer_resumes(self):
        await self.codex_turn(forge=True)

    async def test_codex_skip_resumes(self):
        await self.codex_turn('skip')

    async def test_codex_stop_while_waiting(self):
        await self.codex_turn('stop')

    async def test_codex_cancel_while_waiting(self):
        await self.codex_turn('cancel')

    async def test_codex_failure_closes_question(self):
        with self.assertLogs('core.codex_brain', level='ERROR'):
            await self.codex_turn('failure')

    async def test_codex_timeout_resumes(self):
        later = permissions.ask_later
        with patch.object(permissions, 'ask_later', side_effect=lambda **kw: later(**kw, timeout=.1)):
            await self.codex_turn('timeout')

    async def test_codex_round_limit(self):
        sid = 'round-limit'
        queue = permissions.open_channel('chat:' + sid)
        self.addCleanup(permissions.close_channel, 'chat:' + sid)
        brain = CodexBrain(session_id=sid)
        prompts = []
        async def process(prompt):
            prompts.append(prompt)
            result = await registry.call('ask_user', {'questions': QUESTIONS},
                                         registry.ToolContext(session_id=sid), registry.CODEX)
            if len(prompts) <= 8:
                self.assertIn('on screen', result)
                payload = queue.get_nowait()
                while 'permission_closed' in payload:
                    payload = queue.get_nowait()
                permissions.respond(payload['id'], answers=ANSWERS, skip=False, user='alice')
            else:
                self.assertIn('limit of 8 question rounds', result)
            yield runs.text(result)
            yield runs.result(True)
        with patch.object(brain, '_run_process', side_effect=process):
            async def collect():
                return [item async for item in brain.events('start')]
            items = await asyncio.wait_for(collect(), 2)
        self.assertEqual(len(prompts), 9)
        self.assertEqual(sum(e.kind == runs.EventKind.RESULT for e in items), 1)
        self.assertFalse(codex_questions._owned)
        self.assertFalse(permissions._pending)

    async def test_deferred_immediate_cancel_closes_card(self):
        queue = permissions.open_channel('chat:immediate')
        self.addCleanup(permissions.close_channel, 'chat:immediate')
        task = permissions.ask_later(surface='chat:immediate', agent_id=None,
                                     raw_questions=QUESTIONS, tool='ask_user')
        payload = queue.get_nowait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(queue.get_nowait(), {'permission_closed': payload['id']})
        self.assertFalse(permissions._pending)

    async def test_codex_silence_wait(self):
        brain = CodexBrain(session_id='silent')
        class Output:
            async def readline(self):
                await asyncio.sleep(.005)
                return b'line\n'
        # Silent polls must keep waiting while the person answers.
        proc = SimpleNamespace(stdout=Output())
        with patch('core.codex_brain.CODEX_MESSAGE_TIMEOUT_SECONDS', .01), patch('core.codex_brain.CODEX_SILENT_HARD_LIMIT_SECONDS', .015), patch.object(brain, '_rollout_progress', return_value=None):
            calls = 0
            async def read():
                nonlocal calls
                calls += 1
                if calls < 4:
                    await asyncio.sleep(.1)
                return b'line\n'
            proc.stdout.readline = read
            with patch.object(permissions, 'waiting', return_value=True) as waiting:
                self.assertEqual(await brain._next_line(proc), b'line\n')
                waiting.assert_called_with('chat:silent')
            with patch.object(permissions, 'waiting', return_value=False):
                proc.stdout.readline = AsyncMock(side_effect=asyncio.TimeoutError)
                with self.assertRaisesRegex(RuntimeError, 'no output'):
                    await brain._next_line(proc)

            proc.stdout.readline = AsyncMock(side_effect=[asyncio.TimeoutError, asyncio.TimeoutError,
                                                         asyncio.TimeoutError, b'after wait\n'])
            # The hard deadline restarts when the question finishes; rollout
            # growth then follows the original watchdog rules.
            with patch.object(permissions, 'waiting', side_effect=[True, False, False]), patch.object(
                    brain, '_rollout_progress', side_effect=[(0, 0), (1, 0), (2, 0), (3, 0)]), patch(
                    'core.codex_brain.time', SimpleNamespace(monotonic=Mock(side_effect=[0, 100, 200, 200.005]))):
                self.assertEqual(await brain._next_line(proc), b'after wait\n')


def tearDownModule():
    environment.cleanup()


if __name__ == '__main__':
    unittest.main()
