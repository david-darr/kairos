"""Antigravity contracts with a real fake CLI process; no vendor/network calls."""
import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import AsyncMock, patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix='agy-test-')
os.environ['JARVIS_DATA_DIR'] = fixture.name

from core import antigravity_cli as cli, antigravity_brain as adapter, codex_questions, model_catalog, model_discovery, model_endpoints, quota_usage, runs, tool_access
from core.session_manager import session_manager
from services import chat_service, model_setup

FAKE = REPO / 'scripts/fixtures/fake_agy.py'
class Pipe:
    def __init__(self, stream):
        self.stream = stream

    async def read(self):
        return await asyncio.to_thread(self.stream.read)

    async def readline(self):
        return await asyncio.to_thread(self.stream.readline)

    def write(self, data):
        self.stream.write(data)

    async def drain(self):
        self.stream.flush()

    def close(self):
        self.stream.close()


class FixtureProcess:
    """Real pipes with thread readers: Windows sandbox denies overlapped pipes.

    Only the test transport differs; the actual fixture still validates argv,
    stdin EOF, process exits, and PID-scoped cancellation.
    """
    def __init__(self, process):
        self.process = process
        self.pid = process.pid
        for name in ('stdin', 'stdout', 'stderr'):
            stream = getattr(process, name)
            setattr(self, name, Pipe(stream) if stream else None)

    @property
    def returncode(self):
        return self.process.poll()

    async def wait(self):
        return await asyncio.to_thread(self.process.wait)

    def kill(self):
        self.process.kill()


class DiscoveryTests(unittest.TestCase):
    def test_fake_rejects_unverified_input_envelopes(self):
        for turn in ({'event': 'user', 'message': 'prompt'},
                     {'event': 'user', 'message': {'content': 'prompt'}},
                     {'event': 'user_message', 'message': {'role': 'user', 'content': 'prompt'}}):
            with self.subTest(turn=turn):
                proc = subprocess.run([sys.executable, str(FAKE), '-p', '',
                                       '--input-format', 'stream-json', '--output-format', 'stream-json'],
                                      input=json.dumps(turn) + '\n', capture_output=True, text=True, timeout=5)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(proc.stdout, '')

    def test_path_local_missing_and_custom(self):
        temp = TestDataDirectory(prefix='agy-path-')
        self.addCleanup(temp.cleanup)
        folder = temp.name
        local = Path(folder) / 'agy/bin/agy.exe'
        local.parent.mkdir(parents=True)
        local.touch()
        with patch.object(cli.platform, 'system', return_value='Windows'), patch.dict(os.environ, {'LOCALAPPDATA': folder, 'ANTIGRAVITY_CLI_PATH': ''}), patch.object(cli.shutil, 'which', return_value='C:/path/agy.exe'):
            self.assertEqual(cli.find_antigravity(), 'C:/path/agy.exe')
            with patch.object(cli.shutil, 'which', return_value=None):
                self.assertEqual(cli.find_antigravity(), str(local))
                local.unlink()
                self.assertIsNone(cli.find_antigravity())
            local.touch()
            with patch.dict(os.environ, {'ANTIGRAVITY_CLI_PATH': str(local)}):
                self.assertEqual(cli.find_antigravity(), str(local))

    def test_probe_fake_signed_in_out_and_missing(self):
        def read(path, *args, **kwargs):
            proc = subprocess.run([sys.executable, str(FAKE), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
            return proc.returncode, proc.stdout, proc.stderr
        with patch.object(cli, 'find_antigravity', return_value='fixture-agy'), patch.object(cli, 'run_readonly', side_effect=read):
            current = cli.probe()
            self.assertTrue(current['signed_in'])
            self.assertEqual(current['version'], '1.4.6')
            self.assertEqual(current['models_found'], 1)
            with patch.dict(os.environ, {'FAKE_AGY_SIGNED_OUT': '1'}):
                self.assertEqual(cli.probe()['message'], cli.SIGN_IN)
        with patch.object(cli, 'find_antigravity', return_value=None):
            self.assertEqual(cli.probe()['status'], 'missing')

    def test_models_effort_variants_and_live_override(self):
        models = cli.parse_models('\x1b[32mgemini-new-low  Gemini New (Low)\x1b[0m\ngemini-new-high  Gemini New (High)\nclaude-x  Claude\ngpt-oss  GPT')
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]['display_name'], 'Gemini New')
        self.assertEqual(models[0]['variants']['high'], 'gemini-new-high')
        async def check():
            model_discovery._cache.clear()
            with patch.object(cli, 'find_antigravity', return_value='fixture'), patch.object(cli, 'probe', return_value={'signed_in': True, 'models': models}):
                live = await model_discovery.list_for_endpoint({'kind': 'antigravity_cli'}, force=True)
                self.assertEqual(live, models)
                self.assertTrue(model_catalog.validate_effort('antigravity_cli', 'gemini-new', 'high'))
                self.assertFalse(model_catalog.validate_effort('antigravity_cli', 'gemini-new', 'max'))
            with patch.object(cli, 'probe', return_value={'signed_in': False, 'status': 'needs_sign_in'}):
                self.assertEqual(await model_discovery.list_for_endpoint({'kind': 'antigravity_cli'}, force=True), [])
        asyncio.run(check())
        model_catalog._antigravity_live = None

    def test_quotas_only_measured(self):
        self.assertEqual(quota_usage.parse_antigravity_limits({'quota': {'gemini': {'remaining_fraction': .75, 'reset_time': '2026-10-24T00:00:00Z'}}})[0]['used_percent'], 25)
        for data in ({}, {'usage': {'total_tokens': 100}}, {'quota': {'gemini': {'remaining_amount': 50}}}, {'quota': {'gemini': {'remaining_fraction': True}}}):
            self.assertEqual(quota_usage.parse_antigravity_limits(data), [])

    def test_connection_rechecks_auth_and_is_idempotent(self):
        current = {'antigravity': {'installed': True, 'signed_in': True}, 'connections': {}}
        with patch.object(model_setup, 'status', return_value=current):
            first = asyncio.run(model_setup.create_connection('antigravity'))
            self.assertEqual(first['connection']['kind'], 'antigravity_cli')
            current['connections']['antigravity_cli'] = [first['connection']]
            second = asyncio.run(model_setup.create_connection('antigravity_cli'))
            self.assertEqual(second['connection']['id'], first['connection']['id'])
            current['antigravity']['signed_in'] = False
            with self.assertRaisesRegex(ValueError, 'Sign in to Antigravity'):
                asyncio.run(model_setup.create_connection('antigravity'))

    def test_usage_is_separate_readonly_report_and_unknown_stays_hidden(self):
        with patch.object(cli, 'find_antigravity', return_value='fixture'), patch.object(cli, 'run_readonly', return_value=(0, '{}', '')) as read:
            with self.assertRaises(quota_usage.NoQuotaReported):
                quota_usage._antigravity_windows()
            self.assertEqual(read.call_args.args[:3], ('fixture', '-p', '/usage'))
            self.assertIn('--disable-slash-commands=false', read.call_args.args)
        with patch.object(quota_usage.model_endpoints, 'list_endpoints', return_value=[{'id': 'g1', 'name': 'Antigravity', 'kind': 'antigravity_cli'}]), patch.object(quota_usage.token_usage, 'get_usage_summary', return_value={}), patch.object(quota_usage.token_usage, 'get_recent_usage', return_value={}), patch.object(quota_usage, '_antigravity_windows', side_effect=quota_usage.NoQuotaReported):
            quota_usage._cache.pop('antigravity', None)
            quota_usage._retry_after.pop('antigravity', None)
            result = quota_usage.get_usage_overlay()
            # No ring without a measured window, but the model is still listed as connected.
            self.assertEqual(result['providers'], [])
            self.assertEqual([(m['id'], m['status'], m['quota']['status']) for m in result['models']], [('g1', 'connected', 'no_quota')])


class TurnTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = TestDataDirectory(prefix='agy-turn-')
        self.addCleanup(self.folder.cleanup)
        self.record = Path(self.folder.name) / 'record.json'
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'FAKE_AGY_RECORD': str(self.record)}))
        self.stack.enter_context(patch.object(cli, 'find_antigravity', return_value='fixture-agy'))
        self.stack.enter_context(patch.object(adapter.system_prompt, 'for_codex', return_value='Kairos tools: ask_user'))
        self.stack.enter_context(patch.object(adapter.projects, 'project_addendum', return_value=''))
        self.stack.enter_context(patch.object(adapter.image_gen, 'GENERATED_FILES_DIR', self.folder.name))
        self.processes = []
        self.kills = []
        async def spawn_checked(*args, **kwargs):
            if args[0] == 'taskkill':
                self.kills.append(args)
                self.assertEqual(args[:4], ('taskkill', '/T', '/F', '/PID'))
                command = args
            else:
                command = (sys.executable, str(FAKE), *args[1:])
            kwargs.pop('limit', None)
            p = FixtureProcess(subprocess.Popen(command, **kwargs))
            self.processes.append(p)
            return p
        def close_pipes():
            for p in self.processes:
                for name in ('stdin', 'stdout', 'stderr'):
                    stream = getattr(p.process, name)
                    if stream and not stream.closed:
                        stream.close()
        self.addCleanup(close_pipes)
        self.stack.enter_context(patch.object(adapter.asyncio, 'create_subprocess_exec', side_effect=spawn_checked))
        self.session = session_manager.create_session('agy-fixture')

    def brain(self, **kwargs):
        return adapter.AntigravityBrain(session_id=self.session['id'], cwd_override=self.folder.name, **kwargs)

    async def test_multiline_stdin_stream_resume_usage_and_factory(self):
        brain = self.brain(model='gemini-4-argon', effort='high')
        events = [e async for e in brain.events('First line\nsecond "quoted" line\nthird line')]
        self.assertEqual(''.join(e.data['text'] for e in events if e.kind == runs.EventKind.TEXT), 'Hello Gemini\n')
        self.assertEqual(len([e for e in events if e.kind == runs.EventKind.TOOL_STARTED]), 1)
        self.assertEqual(len([e for e in events if e.kind == runs.EventKind.TOOL_FINISHED]), 1)
        self.assertEqual(brain.last_usage['total_tokens'], 13)
        record = json.loads(self.record.read_text())
        self.assertEqual(record['args'][record['args'].index('-p') + 1], '')
        self.assertNotIn('First line', ' '.join(record['args']))
        self.assertIn('First line\nsecond "quoted" line', json.loads(record['stdin'])['message']['content'])
        self.assertEqual(json.loads(record['stdin'])['event'], 'user')
        self.assertEqual(json.loads(record['stdin'])['message']['role'], 'user')
        self.assertEqual(len(record['stdin'].splitlines()), 1)
        self.assertEqual(record['args'][record['args'].index('--model') + 1], 'gemini-4-argon-high')
        fresh = self.brain()
        self.assertEqual(fresh.thread_id, 'agy-fixture-conversation')
        await fresh.run_turn('Remember')
        args = json.loads(self.record.read_text())['args']
        self.assertEqual(args[args.index('--conversation') + 1], fresh.thread_id)
        self.assertIsInstance(chat_service._build_brain({'id': 'fixture', 'kind': 'antigravity_cli', 'model': ''}, self.session['id']), adapter.AntigravityBrain)

    async def test_modes_and_resume_boundary(self):
        for admin, mode, agent, readonly, expected, bypass in [
            (False, 'auto', False, False, 'accept-edits', False),
            (True, 'base', False, False, 'accept-edits', False),
            (True, 'auto', False, False, 'auto', True),
            (True, 'auto', True, False, 'auto', False),
            (True, 'auto', False, True, 'plan', False),
        ]:
            session_manager.set_permission_mode(self.session['id'], mode)
            b = self.brain(is_admin=admin, agent_auto=agent, read_only=readonly)
            args = b._build_args('agy')
            self.assertEqual(args[args.index('--mode') + 1], expected)
            self.assertEqual('--dangerously-skip-permissions' in args, bypass)
            self.assertEqual('--sandbox' in args, not bypass)
        session_manager.set_antigravity_conversation_id(self.session['id'], 'private')
        session_manager.set_model_endpoint(self.session['id'], 'another')
        self.assertIsNone(self.brain().thread_id)

    async def test_error_and_denial_cleanup(self):
        for name, message in [('FAKE_AGY_ERROR', 'fixture error'), ('FAKE_AGY_DENIED', 'approval replies'), ('FAKE_AGY_APPROVAL', 'approval replies')]:
            b = self.brain()
            with patch.dict(os.environ, {name: '1'}):
                with self.assertRaisesRegex(RuntimeError, message):
                    await b.run_turn('test')
            self.assertIsNone(b._proc)

    async def test_final_only_does_not_charge_cumulative_usage(self):
        b = self.brain()
        b.last_usage = {'total_tokens': 123}
        with patch.dict(os.environ, {'FAKE_AGY_FINAL_ONLY': '1', 'FAKE_AGY_CUMULATIVE': '1'}):
            self.assertEqual(await b.run_turn('answer'), 'Final response')
        self.assertIsNone(b.last_usage)

    async def test_final_only_single_turn_usage(self):
        b = self.brain()
        with patch.dict(os.environ, {'FAKE_AGY_FINAL_ONLY': '1'}):
            events = [e async for e in b.events('answer')]
        self.assertEqual(''.join(e.data['text'] for e in events if e.kind == runs.EventKind.TEXT), 'Final response')
        self.assertEqual(b.last_usage['total_tokens'], 9999)
        self.assertEqual(len([e for e in events if e.kind == runs.EventKind.USAGE]), 1)

    async def test_warnings_and_unknown_step_are_nonfatal(self):
        b = self.brain()
        with patch.dict(os.environ, {'FAKE_AGY_WARNINGS': '1', 'FAKE_AGY_UNKNOWN_STEP': '1'}), self.assertLogs(adapter.logger, level='WARNING') as logs:
            events = [e async for e in b.events('answer')]
        self.assertEqual(''.join(e.data['text'] for e in events if e.kind == runs.EventKind.TEXT), 'Hello Gemini\n')
        self.assertTrue(any('future_step' in message for message in logs.output))
        self.assertEqual(events[-1].kind, runs.EventKind.RESULT)

    async def test_file_tool_error_maps_to_failed_action(self):
        b = self.brain()
        with patch.dict(os.environ, {'FAKE_AGY_TOOL_ERROR': '1'}):
            events = [e async for e in b.events('edit')]
        result = next(e for e in events if e.kind == runs.EventKind.TOOL_FINISHED)
        self.assertFalse(result.data['ok'])
        self.assertIn('edit refused', result.data['output'])

    async def test_background_metadata_without_invented_completion(self):
        from core import chat_tasks
        b = self.brain()
        with patch.dict(os.environ, {'FAKE_AGY_SUBAGENT': '1'}):
            await b.run_turn('research')
        item = chat_tasks._session(b.session_id)['items']['antigravity:child']
        self.assertEqual(item['source'], 'antigravity')
        self.assertEqual(item['status'], 'stopped')
        self.assertNotIn('private://', json.dumps(item))

    async def test_cancel_pid_only(self):
        b = self.brain()
        with patch.dict(os.environ, {'FAKE_AGY_HANG': '1'}):
            turn = asyncio.create_task(b.run_turn('wait'))
            for _ in range(100):
                if self.record.exists():
                    break
                await asyncio.sleep(.03)
            proc = b._proc
            self.assertIsNotNone(proc)
            stopped = await b.cancel()
            await asyncio.gather(turn, return_exceptions=True)
            if os.name == 'nt':
                self.assertEqual(stopped.confirmed, self.processes[1].returncode == 0)
                self.assertTrue(self.kills)
            else:
                self.assertTrue(stopped.confirmed)
            self.assertIsNotNone(proc.returncode)

    async def test_shared_ask_user_round(self):
        b = self.brain()
        calls = []
        async def process(prompt):
            calls.append(prompt)
            if len(calls) == 1:
                async def answer():
                    from types import SimpleNamespace
                    return SimpleNamespace(status='answered', answers={'Color': 'Blue'})
                codex_questions.register(b.session_id, asyncio.create_task(answer()))
            yield runs.result(False)
        with patch.object(b, '_run_process', side_effect=process):
            events = [e async for e in b.events('choose')]
        self.assertEqual(len(calls), 2)
        self.assertIn('Color: Blue', calls[1])


if __name__ == '__main__':
    unittest.main()
