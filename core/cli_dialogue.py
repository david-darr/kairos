"""Call conversations on a subscription sign-in (Claude Code, Codex, Antigravity), tool-free.

The same face as core/voice_dialogue.Conversation: prepare(), stream(messages, max_tokens), close(). The call's real work
still goes to the bot through <kairos-work> (services/agent_calls.py delegate); nothing here can act.

- Claude Code keeps ONE warm process per call: a ClaudeSDKClient (stream-json in and out) with every tool removed
  (tools=[], no MCP, no settings files, an empty working folder), opened at prepare(). Each turn sends only what is new
  since the last one, so the process keeps the conversation and its prompt cache. Text streams as it is written.
- Codex and Antigravity have no input mode that stays open between turns here (codex exec answers once; agy needs end
  of input before it starts), so each turn is one short read-only process given the whole call so far. Codex sends its
  reply whole. Both are listed as slower (SLOWER) and never picked as the default when an API or local model exists.
"""
import asyncio
import contextlib
import json
import logging
import subprocess
import tempfile

from core import cli_env, model_endpoints

logger = logging.getLogger(__name__)

CLI_KINDS = ('claude_cli', 'codex_cli', 'antigravity_cli')
# Measured with scripts/bench_voice_turn.py --conversation (2026-11-10, five warm turns each, first whole sentence p50/p95):
# Claude Code on Haiku 615/710 ms (call start 1.4 s), Claude Code on its default model 2,470/4,359 ms, Codex 3,509/4,059 ms
# (whole reply at once), Antigravity 7,217/7,672 ms, local llama3.2 112 ms once loaded. Over ~2.5 s is "slower": offered
# in Call settings with that word beside it, never the automatic default while an API or local model exists.
SLOWER = {'codex_cli', 'antigravity_cli'}
# Claude Code talks on Haiku unless a model version is chosen in Call settings: the bot's real work keeps its own model.
CLAUDE_CALL_MODEL = 'haiku'
TURN_TIMEOUT = 90
CONNECT_TIMEOUT = 60


def render(messages) -> str:
    """The call so far as one prompt, for a process that starts fresh each turn."""
    system = [m['content'] for m in messages if m['role'] == 'system']
    dialogue = [m for m in messages if m['role'] != 'system']
    lines = '\n'.join(f"{m['role']}: {m['content']}" for m in dialogue)
    return ('[Call instructions:]\n' + '\n\n'.join(system) + '\n\n[The call so far:]\n' + (lines or '(nothing yet)') +
            '\n\n[Reply now as the assistant. Spoken words only, no tools, no files, no commands.]')


def _delta(messages, said_last: str) -> str:
    """What a warm session has not seen yet: the instructions (always: they carry the work records, which change),
    the person's words since the assistant last spoke, and whether that last reply was cut short."""
    system = [m['content'] for m in messages if m['role'] == 'system']
    last = max((i for i, m in enumerate(messages) if m['role'] == 'assistant'), default=-1)
    new = [m['content'] for m in messages[last + 1:] if m['role'] == 'user']
    parts = ['[Call instructions, current (data and rules for your next reply):]\n' + '\n\n'.join(system)]
    if last >= 0 and said_last and messages[last]['content'].strip() != said_last.strip():
        parts.append('[Your previous reply was cut off. The person heard only this much of it:]\n' + messages[last]['content'])
    parts.append('[The person said:]\n' + ('\n'.join(new) if new else '(nothing new; follow the instructions above)'))
    return '\n\n'.join(parts)


class ClaudeConversation:
    """One warm Claude Code process for the whole call."""
    kind = 'claude_cli'

    def __init__(self, endpoint, model):
        self.endpoint_id = endpoint['id']
        self.model = model or CLAUDE_CALL_MODEL
        self.account = cli_env.account_for_endpoint(endpoint)
        self.local = False
        self._client = None
        self._folder = None
        self._said = ''
        self._drain = None
        self._lock = asyncio.Lock()

    def _options(self, system):
        from claude_agent_sdk import ClaudeAgentOptions
        from core import claude_cli

        async def deny(name, arguments, context):
            from claude_agent_sdk import PermissionResultDeny
            return PermissionResultDeny(message='A call conversation cannot use tools', interrupt=True)
        return ClaudeAgentOptions(cli_path=claude_cli.preferred_cli_path(), cwd=self._folder.name, model=self.model,
                                  tools=[], allowed_tools=[], mcp_servers={}, strict_mcp_config=True, setting_sources=[],
                                  can_use_tool=deny, permission_mode='default', include_partial_messages=True,
                                  system_prompt=system, env=cli_env.homes(self.account))

    async def _connect(self):
        from claude_agent_sdk import ClaudeSDKClient
        self._folder = self._folder or tempfile.TemporaryDirectory(prefix='kairos-call-', ignore_cleanup_errors=True)
        client = ClaudeSDKClient(options=self._options(
            'You are the speaking voice of a Kairos bot on a live voice call. Each message from the user carries the '
            'current call instructions and what the person said. Follow those instructions and reply with spoken words only.'))
        await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
        self._client = client

    async def prepare(self):
        async with self._lock:
            if self._client is None:
                await self._connect()

    async def _settle(self):
        """A reply cut off mid-stream is still being written: let it finish (or start a fresh process) first."""
        if self._drain is None:
            return
        drain, self._drain = self._drain, None
        try:
            await asyncio.wait_for(drain, timeout=8)
        except (asyncio.TimeoutError, Exception):
            drain.cancel()
            await self._reset()

    async def _reset(self):
        client, self._client = self._client, None
        if client is not None:
            with contextlib.suppress(Exception):
                await client.disconnect()

    async def stream(self, messages, max_tokens=320, oneshot=False):
        if oneshot:
            async for text in self._oneshot(messages):
                yield text
            return
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
        from claude_agent_sdk.types import StreamEvent
        async with self._lock:
            await self._settle()
            if self._client is None:
                await self._connect()
            prompt = _delta(messages, self._said)
            await asyncio.wait_for(self._client.query(prompt), timeout=CONNECT_TIMEOUT)
            replies = self._client.receive_response().__aiter__()
            said, streamed, finished = [], False, False
            try:
                while True:
                    message = await asyncio.wait_for(replies.__anext__(), timeout=TURN_TIMEOUT)
                    if isinstance(message, StreamEvent):
                        event = message.event or {}
                        delta = event.get('delta') or {}
                        if event.get('type') == 'content_block_delta' and delta.get('type') == 'text_delta' and delta.get('text'):
                            streamed = True; said.append(delta['text'])
                            yield delta['text']
                    elif isinstance(message, AssistantMessage) and not streamed:
                        for block in message.content:
                            if isinstance(block, TextBlock) and block.text:
                                said.append(block.text)
                                yield block.text
                    elif isinstance(message, ResultMessage):
                        finished = True
                        if message.is_error:
                            raise ValueError('The conversation model failed. Check its connection or choose another model.')
                        return
            except StopAsyncIteration:
                finished = True
            finally:
                self._said = ''.join(said)
                if not finished:
                    # Interrupted: the process is still writing this reply. Read it to its end in the background.
                    async def rest():
                        with contextlib.suppress(StopAsyncIteration):
                            while not isinstance(await replies.__anext__(), ResultMessage):
                                pass
                    self._drain = asyncio.ensure_future(rest())

    async def _oneshot(self, messages):
        """A summary: its own short process, so it never mixes with the call's conversation."""
        from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, ResultMessage, TextBlock
        system = '\n\n'.join(m['content'] for m in messages if m['role'] == 'system')
        user = '\n\n'.join(m['content'] for m in messages if m['role'] != 'system')
        self._folder = self._folder or tempfile.TemporaryDirectory(prefix='kairos-call-', ignore_cleanup_errors=True)
        client = ClaudeSDKClient(options=self._options(system))
        try:
            await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
            await asyncio.wait_for(client.query(user), timeout=CONNECT_TIMEOUT)
            replies = client.receive_response().__aiter__()
            while True:
                message = await asyncio.wait_for(replies.__anext__(), timeout=TURN_TIMEOUT * 2)
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text:
                            yield block.text
                if isinstance(message, ResultMessage):
                    if message.is_error:
                        raise ValueError('The conversation model failed.')
                    return
        finally:
            with contextlib.suppress(Exception):
                await client.disconnect()

    async def close(self):
        if self._drain is not None:
            self._drain.cancel(); self._drain = None
        await self._reset()
        if self._folder is not None:
            with contextlib.suppress(Exception):
                self._folder.cleanup()
            self._folder = None


async def _kill(proc):
    if proc.returncode is not None:
        return
    from core.codex_brain import _kill_process_tree
    try:
        await _kill_process_tree(proc)
    except Exception:
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()


class ProcessConversation:
    """Codex or Antigravity: one read-only process per turn, given the whole call so far."""

    def __init__(self, endpoint, model):
        self.kind = endpoint['kind']
        self.endpoint_id = endpoint['id']
        self.model = model or endpoint.get('model') or None
        self.account = cli_env.account_for_endpoint(endpoint)
        self.local = False

    async def prepare(self):
        if self.kind == 'codex_cli':
            from core import codex_cli
            if not codex_cli.find_codex():
                raise ValueError('Codex is not installed on this computer. Choose another conversation model.')
        else:
            from core import antigravity_cli
            if not antigravity_cli.find_antigravity():
                raise ValueError('Antigravity is not installed on this computer. Choose another conversation model.')

    def _args(self, folder):
        if self.kind == 'codex_cli':
            from core import codex_cli
            from core.codex_features import disabled_feature_args
            # Codex's own tools cannot be removed: an empty folder, read-only, never asking, nothing saved.
            args = [codex_cli.find_codex(), 'exec', *disabled_feature_args(), '--json', '--skip-git-repo-check', '--ephemeral',
                    '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"', '-s', 'read-only', '-C', folder]
            return args + (['-m', self.model] if self.model else []) + ['-']
        from core import antigravity_cli
        args = [antigravity_cli.find_antigravity(), '-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json',
                '--disable-slash-commands', '--mode', 'plan', '--sandbox']
        return args + (['--model', self.model] if self.model else [])

    async def stream(self, messages, max_tokens=320, oneshot=False):
        prompt = render(messages)
        # A process tree that just stopped can hold its folder for a moment on Windows: never fail the turn on that.
        with tempfile.TemporaryDirectory(prefix='kairos-call-', ignore_cleanup_errors=True) as folder:
            env = {k: v for k, v in cli_env.env_for(self.account).items() if k not in ('JARVIS_TOOL_TOKEN', 'JARVIS_API_BASE')}
            proc = await asyncio.create_subprocess_exec(*self._args(folder), cwd=folder, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=10 * 1024 * 1024, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                payload = prompt if self.kind == 'codex_cli' else json.dumps({'event': 'user', 'message': {'role': 'user', 'content': prompt}}) + '\n'
                proc.stdin.write(payload.encode('utf-8')); await proc.stdin.drain(); proc.stdin.close()
                failed = False
                while True:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=TURN_TIMEOUT)
                    if not line:
                        break
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if self.kind == 'codex_cli':
                        item = event.get('item') or {}
                        if event.get('type') == 'item.completed' and item.get('type') == 'agent_message' and item.get('text'):
                            yield item['text']
                        failed = failed or event.get('type') in ('turn.failed', 'error')
                    else:
                        kind = event.get('event'); payload = event.get(kind) if isinstance(event.get(kind), dict) else {}
                        if kind == 'step_update' and payload.get('step_type') == 'agent_response' and isinstance(payload.get('text_delta'), str):
                            yield payload['text_delta']
                        failed = failed or kind == 'error' or (kind == 'result' and payload.get('status') not in (None, 'SUCCESS'))
                code = await asyncio.wait_for(proc.wait(), timeout=10)
                if failed or code:
                    raise ValueError('The conversation model failed. Check its sign-in or choose another model.')
            finally:
                await _kill(proc)

    async def close(self):
        return None


def conversation_for(endpoint, model):
    return ClaudeConversation(endpoint, model) if endpoint['kind'] == 'claude_cli' else ProcessConversation(endpoint, model)
