"""Isolated regression coverage for stream-owned background work."""
import asyncio
import os
import unittest
import uuid
import json
import time
import re
import subprocess
import sys
from unittest.mock import patch, AsyncMock
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix='bg-test-')
test_dir = Path(fixture.name)
os.environ['JARVIS_DATA_DIR'] = fixture.name

from core.brain import Brain
from core import chat_tasks
from claude_agent_sdk import AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock, UserMessage, ResultMessage


def result():
    return ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1,
                         is_error=False, num_turns=1, session_id='scripted', usage={})


class ScriptedClient:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.jobs = []

    async def query(self, text):
        if text == 'next':
            messages = [AssistantMessage([TextBlock('real reply')], 'fake'), result()]
        else:
            started = type('TaskStartedMessage', (), {})()
            started.task_id = 'agent-one'
            started.description = 'Survey'
            started.data = {'is_backgrounded': True, 'task_type': 'local_agent', 'tool_use_id': 'agent-tool'}
            messages = [AssistantMessage([ToolUseBlock('agent-tool', 'Agent', {'description': 'Survey', 'prompt': 'Inspect', 'run_in_background': True})], 'fake'),
                        started, AssistantMessage([TextBlock('started')], 'fake'), result()]
            self.jobs.append(asyncio.create_task(self.finish()))
        for message in messages:
            await self.queue.put(message)

    async def finish(self):
        await asyncio.sleep(.02)
        notification = type('TaskNotificationMessage', (), {})()
        notification.task_id = 'agent-one'
        notification.status = 'completed'
        notification.summary = 'Survey completed'
        notification.data = {}
        init = type('SystemMessage', (), {})()
        init.subtype, init.data = 'init', {}
        update = message('TaskUpdatedMessage', task_id='agent-one', patch={'status': 'completed', 'end_time': int(time.time() * 1000)}, data={})
        for item in [update, notification, init, AssistantMessage([TextBlock('Subagent finished')], 'fake'), result()]:
            await self.queue.put(item)

    async def receive_messages(self):
        while True:
            yield await self.queue.get()

    async def receive_response(self):
        async for message in self.receive_messages():
            yield message
            if isinstance(message, ResultMessage):
                break

    async def disconnect(self):
        for job in self.jobs:
            job.cancel()
        await asyncio.gather(*self.jobs, return_exceptions=True)


class BackgroundStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_subagent_tools_taint_but_text_is_hidden(self):
        brain = Brain(vault_dir=fixture.name)
        async def stream():
            yield AssistantMessage([ToolUseBlock('web', 'WebFetch', {'url': 'https://example.test'})], 'fake', parent_tool_use_id='parent')
            yield UserMessage(content=[ToolResultBlock(tool_use_id='web', content='outside content')], parent_tool_use_id='parent')
            yield AssistantMessage([TextBlock('private subagent reply')], 'fake', parent_tool_use_id='parent')
            yield AssistantMessage([TextBlock('main reply')], 'fake')
            yield result()
        events = [e async for e in brain._message_events(stream())]
        self.assertTrue(brain.turn_taint.tainted)
        tally = __import__('core.runs', fromlist=['Tally']).Tally()
        for e in events:
            tally.add(e)
        self.assertEqual(''.join(tally.parts), 'main reply')
        self.assertEqual(len(tally.timeline), 2)

    async def test_terminal_expectations_batch_grace_and_late_turn(self):
        for status in ('completed', 'failed', 'stopped'):
            with self.subTest(status=status):
                brain = Brain(vault_dir=fixture.name, session_id=uuid.uuid4().hex)
                brain._client = ScriptedClient()
                saved = []
                async def save(text, *args):
                    saved.append(text)
                brain.followup_handler = save
                for ident in ('one', 'two'):
                    brain._observe(message('TaskStartedMessage', task_id=ident, data={'is_backgrounded': True}))
                brain._idle = asyncio.create_task(brain._between_turns())
                try:
                    for ident in ('one', 'two'):
                        await brain._client.queue.put(message('TaskNotificationMessage', task_id=ident, status=status, data={}))
                    await asyncio.sleep(.02)
                    self.assertFalse(brain._idle.done(), 'Reader must survive the last terminal task')
                    for item in (message('SystemMessage', subtype='init'), AssistantMessage([TextBlock('both answered')], 'fake'), result()):
                        await brain._client.queue.put(item)
                    for _ in range(100):  # the self-started turn is read on the reader's own schedule
                        if saved:
                            break
                        await asyncio.sleep(.01)
                    self.assertEqual(saved, ['both answered'])
                    await asyncio.wait_for(brain.settle_background(), .2)
                    self.assertEqual(await brain.run_turn('next'), 'real reply')
                finally:
                    await brain.disconnect()

    async def test_missing_followup_waits_only_grace(self):
        brain = Brain(vault_dir=fixture.name, session_id=uuid.uuid4().hex)
        brain._client = ScriptedClient()
        brain._observe(message('TaskStartedMessage', task_id='one', data={'is_backgrounded': True}))
        brain._observe(message('TaskNotificationMessage', task_id='one', status='completed', data={}))
        brain._idle = asyncio.create_task(brain._between_turns())
        try:
            with patch('core.brain.FOLLOWUP_GRACE_SECONDS', .04, create=True):
                began = time.monotonic()
                await asyncio.wait_for(brain.settle_background(), .3)
                self.assertGreaterEqual(time.monotonic() - began, .025)
        finally:
            await brain.disconnect()

    async def test_final_completion_waits_for_delayed_cli_init(self):
        class DelayedClient(ScriptedClient):
            async def finish(self):
                await asyncio.sleep(.02)
                await self.queue.put(message('TaskNotificationMessage', task_id='agent-one', status='completed', data={}, summary='Completed'))
                await asyncio.sleep(.6)
                for item in (message('SystemMessage', subtype='init', data={}), AssistantMessage([TextBlock('Subagent finished')], 'fake'), result()):
                    await self.queue.put(item)
        brain = Brain(vault_dir=fixture.name, session_id='delayed-init')
        brain._client = DelayedClient()
        try:
            await brain.run_turn('start')
            await asyncio.sleep(.08)
            self.assertEqual(await asyncio.wait_for(brain.run_turn('next'), 2), 'real reply')
        finally:
            await brain.disconnect()

    async def test_disconnect_cancels_waiting_for_an_autonomous_init(self):
        brain = Brain(vault_dir=fixture.name, session_id='disconnect-pending')
        brain._client = ScriptedClient()
        await brain.run_turn('start')
        brain._observe(message('TaskNotificationMessage', task_id='agent-one', status='completed', data={}))
        await asyncio.wait_for(brain.disconnect(), .3)

    async def test_next_turn_consumes_its_own_reply(self):
        brain = Brain(vault_dir=fixture.name, session_id='regression')
        brain._client = ScriptedClient()
        try:
            self.assertEqual(await brain.run_turn('start'), 'started')
            await asyncio.sleep(.08)
            self.assertEqual(await brain.run_turn('next'), 'real reply')
        finally:
            await brain.disconnect()

    async def test_service_saves_followup_before_next_user(self):
        from services import chat_service
        from services.chat_background import attach
        from core.session_manager import session_manager
        session = session_manager.create_session()
        sid = session['id']
        brain = Brain(vault_dir=fixture.name, session_id=sid)
        brain._client = ScriptedClient()
        endpoint = {'id': 'fake', 'name': 'Scripted', 'kind': 'claude_cli'}
        attach(sid, brain, endpoint, False)
        chat_service._brains[sid] = brain
        try:
            with patch.object(chat_service, '_resolve_endpoint', return_value=endpoint), \
                 patch.object(chat_service, '_get_brain', AsyncMock(return_value=(brain, False))), \
                 patch.object(chat_service, '_compact_if_nearly_full', AsyncMock()), \
                 patch.object(chat_service, '_reply_hook'), \
                 patch.object(chat_service, '_record_turn_telemetry'):
                async with chat_service.session_operation(sid):
                    self.assertEqual(''.join([s async for s in chat_service._stream_message(sid, 'start') if isinstance(s, str)]), 'started')
                async with chat_service.session_operation(sid):
                    await asyncio.sleep(.08)
                    self.assertEqual(''.join([s async for s in chat_service._stream_message(sid, 'next') if isinstance(s, str)]), 'real reply')
            messages = session_manager.get_session(sid)['messages']
            follow = next(i for i, msg in enumerate(messages) if msg.get('background_followup'))
            user = next(i for i, msg in enumerate(messages) if msg['content'] == 'next')
            self.assertLess(follow, user)
            self.assertEqual(messages[-1]['content'], 'real reply')
        finally:
            chat_service._brains.pop(sid, None)
            await brain.disconnect()

    async def test_self_turn_permission_is_denied(self):
        brain = Brain(vault_dir=fixture.name, session_id='permission')
        brain._self_turn = True
        result = await asyncio.wait_for(brain._permission('Bash', {'command': 'echo hello'}, SimpleNamespace()), .2)
        self.assertEqual(result.behavior, 'deny')

    async def test_settle_waits_for_followup_with_another_task_running(self):
        brain = Brain(vault_dir=fixture.name, session_id='settle')
        brain._client = ScriptedClient()
        completed = []
        async def save(*args):
            await asyncio.sleep(.05)
            completed.append(args[0])
        brain.followup_handler = save
        try:
            await brain.run_turn('start')
            brain._observe(message('TaskStartedMessage', task_id='held', description='Still running', data={'is_backgrounded': True}))
            for _ in range(100):
                if brain._self_turn:
                    break
                await asyncio.sleep(.01)
            await asyncio.wait_for(brain.settle_background(), .5)
            self.assertEqual(completed, ['Subagent finished'])
        finally:
            await brain.disconnect()

    async def test_disconnect_stops_stream_items(self):
        brain = Brain(vault_dir=fixture.name, session_id='disconnect')
        brain._client = ScriptedClient()
        await brain.run_turn('start')
        await brain.disconnect()
        self.assertEqual(chat_tasks.items('disconnect')[0]['status'], 'stopped')
        self.assertEqual(chat_tasks.items('disconnect')[0]['activity'], 'The Claude Code session closed')

    async def test_codex_consumer_feeds_registry_and_stops_on_end(self):
        from core.codex_brain import CodexBrain
        sid = 'codex-consumer'
        brain = CodexBrain(vault_dir=fixture.name, session_id=sid)
        lines = [{'type': 'item.started', 'item': {'id': 'call', 'type': 'collab_tool_call', 'tool': 'spawn_agent', 'receiver_thread_ids': ['worker'], 'prompt': 'Inspect the code'}},
                 {'type': 'turn.completed', 'usage': {}}]
        stream = asyncio.StreamReader()
        stream.feed_data(('\n'.join(json.dumps(line) for line in lines) + '\n').encode()); stream.feed_eof()
        proc = SimpleNamespace(stdout=stream, returncode=0, wait=AsyncMock(return_value=0))
        stderr = asyncio.create_task(asyncio.sleep(0, result=b''))
        events = [item async for item in brain._consume_process(proc, stderr, True, 'inspect')]
        self.assertTrue(events)
        item = chat_tasks.items(sid)[0]
        self.assertEqual(item['status'], 'stopped')
        self.assertEqual(item['activity'], 'Ended with the Codex turn')

    async def test_listener_trailing_call_is_guaranteed(self):
        calls = []
        chat_tasks.set_listener(lambda sid: calls.append(sid))
        sid = 'throttle-' + uuid.uuid4().hex
        try:
            chat_tasks.claude_message(sid, message('TaskStartedMessage', task_id='one', description='Survey', data={'is_backgrounded': True}))
            chat_tasks.claude_message(sid, message('TaskProgressMessage', task_id='one', description='Inspecting'))
            self.assertEqual(calls, [sid])
            await asyncio.sleep(.45)
            self.assertEqual(calls, [sid, sid])
        finally:
            chat_tasks.set_listener(None)


def message(cls, **fields):
    value = type(cls, (), {})()
    for key, field in fields.items():
        setattr(value, key, field)
    return value


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.sid = 'registry-' + uuid.uuid4().hex

    def feed(self, cls, **fields):
        chat_tasks.claude_message(self.sid, message(cls, **fields))

    def start(self, ident='one', kind='local_agent', **extra):
        self.feed('TaskStartedMessage', task_id=ident, description='Survey', data={
            'is_backgrounded': True, 'task_type': kind, **extra})

    def test_bash_only_output_path_and_readable_steps(self):
        self.feed('AssistantMessage', content=[SimpleNamespace(name='Agent', id='agent', input={})])
        self.start(tool_use_id='agent')
        self.feed('UserMessage', content=[SimpleNamespace(tool_use_id='agent', content='Output is being written to: bad.output')])
        self.assertNotIn('_output_file', chat_tasks._session(self.sid)['tools']['agent'])
        for name, inp, expected in [('Read', {'file_path': 'core/brain.py'}, 'core/brain.py'), ('Grep', {'pattern': 'TODO'}, 'TODO'), ('Bash', {'command': 'echo sub-hello'}, 'echo sub-hello')]:
            self.feed('AssistantMessage', parent_tool_use_id='agent', content=[SimpleNamespace(name=name, input=inp)])
            self.assertEqual(chat_tasks.items(self.sid)[0]['activity'], name + ': ' + expected)
        self.feed('UserMessage', parent_tool_use_id='agent', content=[SimpleNamespace(tool_use_id='read', content=[{'type': 'text', 'text': 'first'}, {'type': 'image', 'text': 'ignored'}, {'type': 'text', 'text': 'second'}])])
        self.assertEqual(chat_tasks.detail(self.sid, 'claude:one')['steps'][-1]['text'], 'first\nsecond')

    def test_output_truncation_flag(self):
        path = test_dir / 'flag.output'
        self.start(kind='local_bash', output_file=str(path))
        with patch('core.chat_tasks.tempfile.gettempdir', return_value=str(test_dir)):
            for size, expected in ((100, False), (16384, False), (16385, True)):
                path.write_bytes(b'x' * size)
                self.assertEqual(chat_tasks.detail(self.sid, 'claude:one')['outputTruncated'], expected)

    def test_card_notes_deduplicate_per_completion(self):
        item = dict(id='card:repeat', kind='agent', source='kairos', label='Repeat', status='done', endedAt=time.time())
        chat_tasks.add_note(self.sid, item); chat_tasks.add_note(self.sid, item)
        item['endedAt'] += 10
        chat_tasks.add_note(self.sid, item)
        self.assertEqual(len(chat_tasks.notes(self.sid)), 2)

    @patch('core.chat_tasks.time.time', return_value=1792710310)
    def test_probe_progress_transcript_and_terminal_notes(self, _clock):
        """Replay a sanitized fixture captured from Claude Code 2.1.280 on 2026-10-22."""
        path = Path(__file__).resolve().parent / 'fixtures' / 'claude_background_probe.jsonl'
        progress_seen = False
        for raw in path.read_text(encoding='utf-8').splitlines():
            record = json.loads(raw)
            cls = record.pop('cls'); record.pop('t', None)
            chat_tasks.claude_message(self.sid, message(cls, **record))
            if cls == 'TaskProgressMessage':
                entry = next(i for i in chat_tasks.items(self.sid) if i['id'] == 'claude:' + record['task_id'])
                self.assertEqual(entry['activity'], 'Running Echo the string sub-hello')
                progress_seen = True
        self.assertTrue(progress_seen)
        items = chat_tasks.items(self.sid)
        self.assertEqual(len(items), 2)
        self.assertTrue(all(i['status'] == 'done' for i in items))
        command = next(i for i in items if i['kind'] == 'command')
        self.assertEqual(command['label'], 'Background sleep and echo command')
        agent = next(i for i in items if i['kind'] == 'subagent')
        self.assertTrue(chat_tasks.detail(self.sid, agent['id'])['steps'])
        self.assertEqual(len(chat_tasks.notes(self.sid)), 2)

    def test_transcript_is_bounded_and_model_output_paths_are_ignored(self):
        self.start(tool_use_id='agent-tool')
        for number in range(65):
            self.feed('AssistantMessage', parent_tool_use_id='agent-tool', content=[SimpleNamespace(text=str(number) + 'x' * 1000)])
        detail = chat_tasks.detail(self.sid, 'claude:one')
        self.assertEqual(len(detail['steps']), 60)
        self.assertTrue(detail['steps'][0]['text'].startswith('5'))
        self.assertTrue(all(len(step['text']) <= 600 for step in detail['steps']))
        self.feed('AssistantMessage', content=[SimpleNamespace(name='Bash', id='bash', input={'description': 'Tests', 'command': 'pytest', 'output_file': 'untrusted.output'})])
        self.start('bash-task', 'local_bash', tool_use_id='bash')
        self.assertEqual(chat_tasks.detail(self.sid, 'claude:bash-task')['outputNote'], 'Output is not available')

    def test_summary_hygiene_and_literal_label(self):
        label = '<img src=x onerror=alert(1)>'
        self.feed('TaskStartedMessage', task_id='x', description=label, data={'is_backgrounded': True, 'task_type': 'local_bash', 'output_file': str(test_dir / 'private.output')})
        item = chat_tasks.items(self.sid)[0]
        self.assertEqual(set(item), set(chat_tasks.KEYS))
        self.assertEqual(item['label'], label)
        detail = chat_tasks.detail(self.sid, item['id'])
        self.assertNotIn('output_file', json.dumps(detail))
        self.assertNotIn(str(test_dir), json.dumps(detail))
        self.assertEqual(detail['outputNote'], 'Output is not available')

    def test_output_tail_policy_and_cleaning(self):
        path = test_dir / 'tail.output'
        path.write_bytes(b'x' * 20000 + b'\x1b[31mhello\x1b[0m\x00\r\n\tend')
        with patch('core.chat_tasks.tempfile.gettempdir', return_value=str(test_dir)):
            output = chat_tasks.output_tail(str(path))
            self.assertTrue(output.endswith('hello\n\tend'))
            self.assertNotIn('\x1b', output)
            self.assertLessEqual(len(output), 16384)
            self.assertIsNone(chat_tasks.output_tail(str(test_dir)))
            other = test_dir / 'tail.txt'; other.write_text('no')
            self.assertIsNone(chat_tasks.output_tail(str(other)))
        with patch('core.chat_tasks.tempfile.gettempdir', return_value=str(test_dir / 'other')):
            self.assertIsNone(chat_tasks.output_tail(str(path)))

    def test_persistence_restart_and_sanitizer(self):
        self.start()
        self.assertTrue(Path(chat_tasks._path(self.sid)).is_file())
        chat_tasks._sessions.pop(self.sid)
        item = chat_tasks.items(self.sid)[0]
        self.assertEqual(item['status'], 'stopped')
        self.assertEqual(item['activity'], 'Kairos restarted while this was running')
        self.assertEqual(len(chat_tasks.notes(self.sid)), 1)
        self.assertIsNone(chat_tasks._path('../x'))
        chat_tasks.forget(self.sid)
        self.assertFalse(Path(chat_tasks._path(self.sid)).exists())

    def test_reconciliation_grace_and_terminal_wins(self):
        self.start()
        self.feed('SystemMessage', subtype='background_tasks_changed', data={'tasks': []})
        self.assertEqual(chat_tasks.items(self.sid)[0]['status'], 'running')
        with patch('core.chat_tasks.time.time', return_value=time.time() + 6):
            chat_tasks.sweep(self.sid)
        self.assertEqual(chat_tasks.items(self.sid)[0]['status'], 'stopped')
        self.start('two')
        self.feed('SystemMessage', subtype='background_tasks_changed', data={'tasks': []})
        self.feed('TaskNotificationMessage', task_id='two', status='completed', summary='Completed', data={})
        self.assertEqual(next(i for i in chat_tasks.items(self.sid) if i['id'] == 'claude:two')['status'], 'done')

    def test_codex_missing_states_and_end_source(self):
        chat_tasks.codex_item(self.sid, {'type': 'collab_tool_call', 'receiver_thread_ids': ['thread'], 'prompt': 'Inspect\nrepo'}, 'item.started')
        item = chat_tasks.items(self.sid)[0]
        self.assertEqual((item['id'], item['label'], item['startedAt']), ('codex:thread', 'Inspect', None))
        chat_tasks.codex_item(self.sid, {'type': 'collab_tool_call', 'receiver_thread_ids': ['thread'], 'agents_states': {'thread': {'status': 'completed', 'message': 'Found it'}}}, 'item.completed')
        self.assertEqual(chat_tasks.items(self.sid)[0]['status'], 'done')
        chat_tasks.codex_item(self.sid, {'type': 'collab_tool_call', 'receiver_thread_ids': ['other']}, 'item.started')
        chat_tasks.end_source(self.sid, 'codex', 'Ended with the Codex turn')
        self.assertEqual(next(i for i in chat_tasks.items(self.sid) if i['id'] == 'codex:other')['status'], 'stopped')


class DerivedTests(unittest.TestCase):
    def setUp(self):
        from core.session_manager import session_manager
        self.sid = session_manager.create_session()['id']

    def test_reopened_computer_and_restarted_app_notes(self):
        from services import background_tasks as bg
        from core.computer import manager
        from services.forge_apps import forge_apps
        base = time.time() - 100
        computer = {'owner': 'chat:' + self.sid, 'started_at': base}
        app = {'running': True, 'started_at': base, 'command': 'npm start'}
        with patch.object(manager, 'running', return_value=[computer]) as running, patch.object(forge_apps, 'records', {self.sid: {}}), patch.object(forge_apps, 'status', return_value=app):
            for offset in (0, 10):
                computer['started_at'] = app['started_at'] = base + offset
                running.return_value = [computer]; app.update(running=True, exit_code=None)
                bg.list_items(self.sid)
                running.return_value = []; app.update(running=False, exit_code=0)
                bg.list_items(self.sid); bg.list_items(self.sid)
        for kind in ('computer', 'app_server'):
            self.assertEqual(len([n for n in chat_tasks.notes(self.sid) if n['kind'] == kind]), 2)

    def test_watcher_ignores_old_history_and_lists_do_not_read_details(self):
        from services import background_tasks as bg
        from services.task_service import task_service
        from core import session_manager_store as store
        old = time.time() - 7200
        cards = [dict(id=str(n), name='Old', schedule_kind='card', status='done', created_at=old,
                      requester={'kind': 'chat', 'session_id': self.sid}) for n in range(300)]
        with store.transaction() as conn:
            conn.executemany('INSERT INTO helpers(id,batch_id,parent,goal,status,created_at,ended_at) VALUES(?,?,?,?,?,?,?)',
                [(uuid.uuid4().hex, 'batch', 'chat:' + self.sid, 'Old', 'done', old, old) for _ in range(300)])
        async def tick():
            with patch.object(task_service, 'list_tasks', return_value=cards), patch.object(store, 'find_runs') as find, patch.object(store, 'run_events') as events, patch.object(task_service, 'list_runs') as receipts, patch.object(bg, '_broadcast') as broadcast:
                with patch('services.background_tasks.asyncio.sleep', side_effect=asyncio.CancelledError):
                    with self.assertRaises(asyncio.CancelledError):
                        await bg._watch()
                find.assert_not_called(); events.assert_not_called(); receipts.assert_not_called()
                self.assertNotIn(self.sid, [c.args[0] for c in broadcast.call_args_list])
        asyncio.run(tick())

    def test_card_running_again_posts_a_second_completion_note(self):
        from services import background_tasks as bg
        from services.task_service import task_service
        card = task_service.create_task('Repeat', 'Repeat', 'card', status='ready',
                                       requester={'kind': 'chat', 'session_id': self.sid})
        began = time.time()
        for offset in (0, 10):
            with patch('services.task_service.time.time', return_value=began + offset):
                task_service.set_card_status(card['id'], 'ready')
                task_service.claim_next_card(card_id=card['id'])
                bg.list_items(self.sid)
                task_service.finish_card(card['id'], 'Finished again')
                bg.list_items(self.sid); bg.list_items(self.sid)
        self.assertEqual(len([n for n in chat_tasks.notes(self.sid) if n['id'] == 'card:' + card['id']]), 2)

    def test_watcher_reuses_grouped_sources_for_sweep_broadcasts(self):
        from services import background_tasks as bg
        async def tick():
            # Sweep may synchronously notify the listener when a stream item
            # expires. It must share this tick's sources too.
            with patch.object(bg, '_source_groups', wraps=bg._source_groups) as sources, \
                 patch.object(chat_tasks, 'sweep', side_effect=lambda: bg._broadcast(self.sid)), \
                 patch('services.background_tasks.asyncio.sleep', side_effect=asyncio.CancelledError):
                # list_items also calls sweep(sid), so keep that call inert.
                chat_tasks.sweep.side_effect = lambda sid=None: bg._broadcast(self.sid) if sid is None else None
                with self.assertRaises(asyncio.CancelledError):
                    await bg._watch()
                self.assertEqual(sources.call_count, 1)
        asyncio.run(tick())

    def test_chat_deletion_and_bulk_wipe_forget_persistence(self):
        from core.session_manager import session_manager
        from core import session_manager_store as store
        chat_tasks.claude_message(self.sid, message('TaskStartedMessage', task_id='one', description='Survey', data={}))
        path = Path(chat_tasks._path(self.sid))
        self.assertTrue(path.exists())
        session_manager.delete_session(self.sid)
        self.assertFalse(path.exists())
        sid = session_manager.create_session()['id']
        chat_tasks.claude_message(sid, message('TaskStartedMessage', task_id='one', description='Survey', data={}))
        path = Path(chat_tasks._path(sid))
        self.assertTrue(path.exists())
        store.delete_all_sessions()
        self.assertFalse(path.exists())

    def test_real_helper_card_bot_assignment_and_schedule_stores(self):
        from core import session_manager_store as store
        from services.background_tasks import list_items, detail
        from services.task_service import task_service
        from services.agent_service import agent_service
        agent = agent_service.create('Background ' + uuid.uuid4().hex[:8])
        with store.transaction() as conn:
            conn.execute('INSERT INTO helpers(id,batch_id,parent,goal,status,created_at) VALUES(?,?,?,?,?,?)',
                         (self.sid, 'batch', 'chat:' + self.sid, 'Inspect helpers', 'running', time.time()))
        cards = []
        for kind in ('chat', 'bot'):
            cards.append(task_service.create_task('Assignment', 'Inspect', 'card', agent_id=agent['id'], status='ready',
                         requester={'kind': kind, 'session_id': self.sid, 'agent_id': agent['id']}))
        schedule = task_service.create_task('Reminder', 'Remember', 'interval', interval_seconds=100, origin_session_id=self.sid)
        items = list_items(self.sid)
        self.assertEqual(next(i for i in items if i['kind'] == 'helper')['status'], 'running')
        self.assertEqual(len([i for i in items if i['kind'] == 'agent']), 2)
        self.assertEqual(next(i for i in items if i['kind'] == 'scheduled')['status'], 'scheduled')
        card = cards[0]
        task_service.claim_next_card(card_id=card['id'])
        self.assertEqual(next(i for i in list_items(self.sid) if i['id'] == 'card:' + card['id'])['status'], 'running')
        inbox = {'id': uuid.uuid4().hex, 'kind': 'question', 'status': 'open', 'card_id': card['id']}
        agent_service._inbox.append(inbox)
        self.assertEqual(next(i for i in list_items(self.sid) if i['id'] == 'card:' + card['id'])['status'], 'waiting')
        inbox['status'] = 'closed'
        task_service.finish_card(card['id'], 'Finished assignment')
        self.assertEqual(detail(self.sid, 'card:' + card['id'])['item']['status'], 'done')
        with patch('core.task_scheduler.run_in_progress', return_value=True):
            self.assertEqual(next(i for i in list_items(self.sid) if i['id'] == 'task:' + schedule['id'])['status'], 'running')

    def test_computer_transitions_and_forge(self):
        from services.background_tasks import list_items
        from core.computer import manager
        from services.forge_apps import forge_apps
        computer = {'owner': 'chat:' + self.sid, 'started_at': time.time(), 'url': 'https://example.test/', 'title': 'Example', 'steps': [{'label': 'Read page'}]}
        app = {'running': True, 'command': 'npm start', 'url': 'http://127.0.0.1:9989/', 'started_at': time.time()}
        with patch.object(manager, 'running', return_value=[computer]), patch.object(forge_apps, 'records', {self.sid: {}}), \
             patch.object(forge_apps, 'status', return_value=app), patch.object(forge_apps, 'logs', return_value={'lines': ['ready']}):
            self.assertEqual(next(i for i in list_items(self.sid) if i['kind'] == 'computer')['activity'], 'Read page')
            computer['taken_over'] = True
            self.assertEqual(next(i for i in list_items(self.sid) if i['kind'] == 'computer')['status'], 'waiting')
            app.update(running=False, exit_code=1)
            self.assertEqual(next(i for i in list_items(self.sid) if i['kind'] == 'app_server')['status'], 'failed')
        with patch.object(manager, 'running', return_value=[]):
            self.assertEqual(next(i for i in list_items(self.sid) if i['kind'] == 'computer')['status'], 'done')
        self.assertEqual(len([n for n in chat_tasks.notes(self.sid) if n['kind'] == 'computer']), 1)

    def test_owner_routes_and_live_packets(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core.middleware import require_user
        from core.session_manager import session_manager
        from routes.background_task_routes import router
        from services.chat_live import visible_packet
        from core.auth import auth_manager
        from core import settings
        app = FastAPI(); app.include_router(router)
        client = TestClient(app)
        self.addCleanup(client.close)
        self.sid = session_manager.create_session(owner_user='alice')['id']
        for user in ('alice', 'bob', 'admin'):
            auth_manager.create_user(user, 'scripted-test-password', is_admin=user == 'admin')
        settings.update_settings(auth_enabled=True)
        try:
            for user in ('bob', 'admin', 'alice'):
                app.dependency_overrides[require_user] = lambda user=user: user
                response = client.get('/api/chat/background/' + self.sid)
                self.assertEqual(response.status_code, 200 if user == 'alice' else 404)
                self.assertEqual(client.get('/api/chat/background/' + self.sid + '/unknown').status_code, 404)
                for kind in ('bg_tasks', 'bg_followup'):
                    self.assertEqual(visible_packet({'type': kind, 'sessionId': self.sid}, user) is not None, user == 'alice')
        finally:
            settings.update_settings(auth_enabled=False)

    def test_live_followup_keeps_caption_flag(self):
        from services import chat_live
        with patch.object(chat_live, 'broadcast_owner') as broadcast:
            chat_live.broadcast_followup(self.sid, {'role': 'assistant', 'content': 'Done', 'background_followup': True})
        self.assertTrue(broadcast.call_args.args[0]['message'].get('background_followup'))

    def test_once_schedule_notes_and_agent_timeline(self):
        from core import runs, session_manager_store as store
        from services.task_service import task_service
        from services.agent_service import agent_service
        from services.background_tasks import list_items, detail
        agent = agent_service.create('Timeline ' + uuid.uuid4().hex[:8])
        card = task_service.create_task('Inspect', 'Inspect', 'card', agent_id=agent['id'], status='ready',
                    requester={'kind': 'chat', 'session_id': self.sid})
        task_service.claim_next_card(card_id=card['id'])
        context = runs.RunContext(surface='card', task_id=card['id'], agent_id=agent['id'])
        tally = runs.Tally(); tally.step('tool_finished', 'Grep', True, '<b>literal tool output</b>', 1.5)
        runs.record(context, tally, 'finished')
        task_service.finish_card(card['id'], 'Found 14 TODOs')
        data = detail(self.sid, 'card:' + card['id'])
        self.assertEqual(data['timeline'][0]['detail'], '<b>literal tool output</b>')
        self.assertEqual(data['output'], 'Found 14 TODOs')
        scheduled = task_service.create_task('Once', 'Once', 'once', run_at='2027-01-01T00:00:00', origin_session_id=self.sid)
        task_service.record_run(scheduled['id'], 'Completed once')
        task_service.update_task(scheduled['id'], enabled=False)
        list_items(self.sid); list_items(self.sid)
        self.assertEqual(len([n for n in chat_tasks.notes(self.sid) if n['id'] == 'task:' + scheduled['id']]), 1)


class FrontendContractTests(unittest.TestCase):
    def test_defined_tokens_text_rendering_and_touch_targets(self):
        root = Path(__file__).resolve().parents[1]
        css = (root / 'static/css/background-tasks.css').read_text()
        existing = '\n'.join(path.read_text(encoding='utf-8') for path in (root / 'static/css').glob('*.css') if path.name != 'background-tasks.css')
        declared = set(re.findall(r'(--[\w-]+)\s*:', existing))
        self.assertTrue(set(re.findall(r'var\((--[\w-]+)', css)) <= declared)
        self.assertNotRegex(css, r'#[0-9a-fA-F]{3,8}\b|rgba?\(')
        self.assertIn('min-height: 44px', css)
        self.assertIn('prefers-reduced-motion: no-preference', css)
        js = (root / 'static/js/backgroundTasks.js').read_text()
        self.assertNotIn('innerHTML', js)
        self.assertNotIn('renderMessageBody', js)
        self.assertNotIn(chr(0x2014), js + css)


class HarnessTests(unittest.TestCase):
    def test_network_guard_rejects_sync_async_dns_and_raw_socket(self):
        code = '''
import asyncio, socket, httpx
from scripts.bg_tasks_scripted import install_network_guard, OutboundNetworkAttempt
install_network_guard()
def blocked(call):
    try:
        call()
    except OutboundNetworkAttempt:
        return
    raise AssertionError('Outbound attempt was not blocked')
blocked(lambda: httpx.get('https://example.test'))
blocked(lambda: socket.getaddrinfo('example.test', 443))
blocked(lambda: socket.create_connection(('example.test', 443)))
with socket.socket() as raw:
    blocked(lambda: raw.connect(('8.8.8.8', 443)))
async def run():
    async with httpx.AsyncClient() as client:
        try:
            await client.get('https://example.test')
        except OutboundNetworkAttempt:
            return
        raise AssertionError('Async outbound attempt was not blocked')
asyncio.run(run())
assert socket.getaddrinfo('127.0.0.1', 8457)
'''
        process = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr)


def tearDownModule():
    fixture.cleanup()


if __name__ == '__main__':
    unittest.main()
