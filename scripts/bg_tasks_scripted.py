"""Real Kairos HTTP/UI with deterministic SDK traffic and no model process.

Run from this worktree: .venv/Scripts/python.exe scripts/bg_tasks_scripted.py
  --port 8457 --data-dir data/review/bg-tasks/demo --scale 1
The last startup line is a JSON object suitable for the Electron smoke test.
"""
import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
import ipaddress
import socket

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class OutboundNetworkAttempt(BaseException):
    """Bypass best-effort network error handlers in production services."""


def install_network_guard():
    """Reject before DNS, including async sockets and HTTP proxy targets."""
    import httpx
    def check(host):
        if isinstance(host, bytes):
            host = host.decode('ascii')
        if str(host).lower() == 'localhost':
            return
        try:
            if ipaddress.ip_address(str(host)).is_loopback:
                return
        except ValueError:
            pass
        raise OutboundNetworkAttempt('Scripted harness blocked outbound network: ' + str(host))
    original_dns = socket.getaddrinfo
    def dns(host, *args, **kwargs):
        check(host)
        return original_dns(host, *args, **kwargs)
    socket.getaddrinfo = dns
    original_create = socket.create_connection
    def create(address, *args, **kwargs):
        check(address[0])
        return original_create(address, *args, **kwargs)
    socket.create_connection = create
    for name in ('connect', 'connect_ex'):
        original = getattr(socket.socket, name)
        def connect(self, address, *args, _original=original, **kwargs):
            if self.family in (socket.AF_INET, socket.AF_INET6):
                check(address[0])
            return _original(self, address, *args, **kwargs)
        setattr(socket.socket, name, connect)
    original_http = httpx.HTTPTransport.handle_request
    def http(self, request):
        check(request.url.host)
        return original_http(self, request)
    httpx.HTTPTransport.handle_request = http
    original_async = httpx.AsyncHTTPTransport.handle_async_request
    async def async_http(self, request):
        check(request.url.host)
        return await original_async(self, request)
    httpx.AsyncHTTPTransport.handle_async_request = async_http


def event(name, **fields):
    item = type(name, (), {})()
    for key, value in fields.items():
        setattr(item, key, value)
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8457)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--scale', type=float, default=1)
    args = parser.parse_args()
    if args.port in (8420, 8430) or not 1024 <= args.port <= 65535:
        parser.error('Use a dedicated test port, never 8420 or 8430')
    if args.scale <= 0:
        parser.error('--scale must be positive')
    data_dir = (args.data_dir or ROOT / 'data/review/bg-tasks' / ('demo-' + uuid.uuid4().hex[:8])).resolve()
    if not data_dir.is_relative_to(ROOT):
        parser.error('--data-dir must be inside this worktree')
    data_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = data_dir / 'temp'; temp_dir.mkdir(exist_ok=True)
    os.environ.update(JARVIS_DATA_DIR=str(data_dir), APP_PORT=str(args.port), AUTH_ENABLED='0', TEMP=str(temp_dir), TMP=str(temp_dir))
    tempfile.tempdir = str(temp_dir)
    install_network_guard()

    from core import quota_usage, model_discovery, mcp_oauth
    async def quotas(*args, **kwargs):
        return {'providers': [], 'recorded': []}
    async def catalog(*args, **kwargs):
        return [model_discovery._entry('scripted', 'Scripted Claude', source='scripted')]
    async def no_refresh(*args, **kwargs):
        pass
    quota_usage.get_usage_overlay_async = quotas
    quota_usage.get_usage_overlay = lambda *args, **kwargs: {'providers': [], 'recorded': []}
    model_discovery.list_for_endpoint = catalog
    mcp_oauth.refresh_due = no_refresh

    from claude_agent_sdk import AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock, UserMessage, ResultMessage, ClaudeAgentOptions
    from core import brain as brain_module

    def result():
        return ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False,
                             num_turns=1, session_id='scripted-background-demo', usage={'input_tokens': 15, 'output_tokens': 12})

    def text(value, parent=None):
        return AssistantMessage(content=[TextBlock(value)], model='scripted', parent_tool_use_id=parent)

    def task(cls, ident, **fields):
        return event(cls, task_id=ident, data=fields, **fields)

    class FakeClient:
        def __init__(self, **kwargs):
            self.queue = asyncio.Queue()
            self.jobs = []
            self.started = False

        async def connect(self):
            pass

        async def query(self, prompt):
            if self.started:
                for item in (text('This is the real reply to your next message.'), result()):
                    self.queue.put_nowait(item)
                return
            self.started = True
            card_ready.set()
            suffix = uuid.uuid4().hex[:7]
            agent_id, command_id, fail_id = 'survey-' + suffix, 'slow-' + suffix, 'failed-' + suffix
            output = temp_dir / 'kairos-bg-demo' / (command_id + '.output')
            output.parent.mkdir(exist_ok=True)
            output.write_text('Starting slow suite\n', encoding='utf-8')
            script = [text('Starting two background jobs.')]
            for ident, tool, label, command in (
                (agent_id, 'Agent', 'Survey the repo for TODOs', 'Look through the repo for TODO comments and report what needs attention.'),
                (command_id, 'Bash', 'Run the slow test suite', 'pytest -q tests/slow'),
                (fail_id, 'Agent', '<img src=x onerror=alert(1)>', 'This scripted subagent demonstrates a failure.')):
                inp = {'description': label, 'run_in_background': True,
                       **({'command': command} if tool == 'Bash' else {'prompt': command, 'subagent_type': 'general-purpose'})}
                script.append(AssistantMessage([ToolUseBlock('tool-' + ident, tool, inp)], 'scripted'))
                script.append(task('TaskStartedMessage', ident, tool_use_id='tool-' + ident, description=label,
                                   is_backgrounded=True, task_type='local_bash' if tool == 'Bash' else 'local_agent'))
            script.append(UserMessage(content=[ToolResultBlock(tool_use_id='tool-' + command_id,
                content=f'Command running in background with ID: {command_id}. Output is being written to: {output}.')]))
            script.append(result())
            for item in script:
                self.queue.put_nowait(item)
            self.jobs = [asyncio.create_task(self.survey(agent_id)), asyncio.create_task(self.command(command_id, output)),
                         asyncio.create_task(self.failure(fail_id))]

        async def survey(self, ident):
            for description, name, command in [('Running Grep TODO', 'Grep', 'TODO'), ('Running Read core/brain.py', 'Read', 'core/brain.py'),
                                                ('Running Read services/chat_service.py', 'Read', 'services/chat_service.py')]:
                await asyncio.sleep(3 * args.scale)
                self.queue.put_nowait(task('TaskProgressMessage', ident, description=description, last_tool_name=name,
                                          usage={'total_tokens': 100, 'tool_uses': 1, 'duration_ms': 3000}))
                self.queue.put_nowait(AssistantMessage([ToolUseBlock(uuid.uuid4().hex, name, {'pattern': command})], 'scripted', parent_tool_use_id='tool-' + ident))
                self.queue.put_nowait(text('Reviewing matching lines.', 'tool-' + ident))
            await asyncio.sleep(11 * args.scale)
            self.finish(ident, 'Found 14 TODO comments.', 'The repo survey finished: 14 TODOs.')

        async def command(self, ident, output):
            for number in range(1, 36):
                await asyncio.sleep(args.scale)
                with output.open('a', encoding='utf-8') as stream:
                    stream.write(f'Slow test {number}: passed\n')
            self.finish(ident, 'Background command "Run the slow test suite" completed (exit code 0)',
                        'The slow suite passed.', output_file=str(output))

        async def failure(self, ident):
            await asyncio.sleep(12 * args.scale)
            self.queue.put_nowait(task('TaskNotificationMessage', ident, status='failed', summary='Scripted failure: the subagent could not finish.'))

        def finish(self, ident, summary, reply, **fields):
            for item in (task('TaskUpdatedMessage', ident, patch={'status': 'completed', 'end_time': int(time.time() * 1000)}),
                         task('TaskNotificationMessage', ident, status='completed', summary=summary, **fields),
                         event('SystemMessage', subtype='init', data={}), text(reply), result()):
                self.queue.put_nowait(item)

        async def receive_messages(self):
            while True:
                yield await self.queue.get()

        async def receive_response(self):
            async for item in self.receive_messages():
                yield item
                if isinstance(item, ResultMessage):
                    break

        async def disconnect(self):
            for job in self.jobs:
                job.cancel()
            await asyncio.gather(*self.jobs, return_exceptions=True)

    brain_module.ClaudeSDKClient = FakeClient
    brain_module.Brain._options = lambda self: ClaudeAgentOptions()
    brain_module.Brain.tool_config_changed = lambda self: False
    from core import settings, model_endpoints, runs
    settings.update_settings(onboarding_complete=True, auth_enabled=False, vault_dir=str(data_dir / 'vault'))
    (data_dir / 'vault').mkdir(exist_ok=True)
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    from services.task_service import task_service
    endpoint = model_endpoints.create_endpoint('Scripted Claude', kind='claude_cli', model='scripted')
    session = session_manager.create_session('Background tasks demo')
    sid = session['id']
    session_manager.set_model_endpoint(sid, endpoint['id'])
    agent = agent_service.create('Repo reviewer', endpoint_id=endpoint['id'])

    card_ready = asyncio.Event()

    async def card_lifecycle():
        await card_ready.wait()
        card = task_service.create_task('Review the background work', 'Review the scripted survey', 'card', status='ready',
                                       agent_id=agent['id'], requester={'kind': 'chat', 'session_id': sid})
        await asyncio.sleep(5 * args.scale)
        task_service.claim_next_card(card_id=card['id'])
        context = runs.RunContext(surface='card', task_id=card['id'], agent_id=agent['id'], endpoint_id=endpoint['id'])
        tally = runs.Tally()
        tally.step('tool_started', 'Grep', detail='Search TODO comments')
        await asyncio.sleep(25 * args.scale)
        tally.step('tool_finished', 'Grep', True, 'Found 14 TODO comments', 1.2)
        tally.step('tool_finished', 'Read', True, 'Reviewed the background task implementation', 2.1)
        runs.record(context, tally, 'finished')
        task_service.finish_card(card['id'], 'Reviewed the survey. The TODOs are ready to prioritize.')

    from app import app
    from services import background_tasks, chat_service
    @asynccontextmanager
    async def harness_lifespan(app):
        # Keep production routes/middleware, with only the deterministic
        # executors enabled. No scheduler, connector or external model starts.
        background_tasks.start()
        lifecycle = asyncio.create_task(card_lifecycle())
        print(json.dumps({'port': args.port, 'sessionId': sid, 'dataDir': str(data_dir)}), flush=True)
        try:
            yield
        finally:
            lifecycle.cancel()
            await asyncio.gather(lifecycle, return_exceptions=True)
            await background_tasks.stop()
            await chat_service.shutdown()
    app.router.lifespan_context = harness_lifespan
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
