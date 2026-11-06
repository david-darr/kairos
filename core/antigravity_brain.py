"""Subscription CLI adapter, using Codex's turn lifecycle and Kairos tool bridge.

Protocol: https://antigravity.google/docs/cli/headless/ (agy 1.4.6).
Stream input does not accept control_response; native approvals cannot be
answered by Kairos. Kairos tools still use the ordinary permissions broker.
"""
import asyncio
import contextlib
import json
import logging
import os
import signal
import subprocess
import sys

from core import antigravity_cli, image_gen, projects, runs, system_prompt, tool_access
from core.codex_brain import CodexBrain, HIVE_MIND_CLI_PATH, _kill_process_tree, _stderr_tail
from core.constants import REPO_CODE_DIRS
from core.custom_tabs import USER_TABS_DIR, ensure_user_tab_dirs
from core.middleware import local_api_base
from core.session_manager import sent_text, session_manager

logger = logging.getLogger(__name__)

APPROVAL_NOTICE = ('Antigravity could not approve a native tool in print mode. '
    'Its stream does not support approval replies. Allow the specific tool in the '
    'Antigravity app/CLI and retry, or continue in Plan mode. Kairos tool approvals still appear here.')


async def kill_tree(proc):
    if os.name == 'nt':
        try:
            return await _kill_process_tree(proc)
        except OSError:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            return False
    # Every POSIX launch below owns its process group, including descendants.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()
    return True


class AntigravityBrain(CodexBrain):
    GRANT_PROVIDER = "antigravity"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        session = session_manager.get_session(self.session_id) if self.session_id else None
        self._forge = self.forge
        self.forge = False  # Codex's question lifecycle must never reset a Codex thread here.
        self.thread_id = None if self._forge else (session or {}).get('antigravity_conversation_id')

    def _build_args(self, executable):
        ensure_user_tab_dirs()
        full_access = self.is_admin and self.permission_mode == 'auto' and not self.agent_auto and not self.read_only
        mode = 'plan' if self.read_only else 'auto' if self.permission_mode == 'auto' else 'accept-edits'
        args = [executable, '-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json',
                '--disable-slash-commands', '--mode', mode]
        if full_access:
            args.append('--dangerously-skip-permissions')
        else:
            args.append('--sandbox')
        if self.thread_id:
            args += ['--conversation', self.thread_id]
        if self.model:
            from core import model_catalog
            entry = model_catalog.get_model('antigravity_cli', self.model)
            model = self.model
            if entry:
                model = entry.get('variants', {}).get(self.effort) or entry.get('cli_model') or model
            args += ['--model', model]
        if self.effort:
            if self.effort not in antigravity_cli.EFFORTS:
                raise ValueError('Unsupported Antigravity effort')
            args += ['--effort', self.effort]
        roots = self._agent_roots() if self.agent_auto else [image_gen.generated_files_dir(), USER_TABS_DIR]
        if self.is_admin and not self.agent_auto:
            roots += list(REPO_CODE_DIRS)
        for root in dict.fromkeys(roots):
            if root == image_gen.generated_files_dir():
                os.makedirs(root, exist_ok=True)
            args += ['--add-dir', root]
        return args

    async def events(self, user_text, stream=True):
        if self._forge:
            self.thread_id = None
            if self.session_id:
                session_manager.set_antigravity_conversation_id(self.session_id, None)
        self.last_usage = None
        # The same ask_user bridge/round limit/cancellation as Codex, without
        # inventing a native question-answer wire protocol.
        async with contextlib.aclosing(super().events(user_text, stream)) as items:
            async for item in items:
                yield item

    def _prompt(self, text):
        guidance = ('Plan mode is read-only.' if self.read_only else
                    'Auto mode explicitly permits full access.' if self.is_admin and self.permission_mode == 'auto' and not self.agent_auto else
                    'The terminal sandbox is enabled. Native tools requiring approval are denied in print mode; explain any denial.')
        if self.thread_id:
            return text + '\n\n[Kairos permissions: ' + guidance + ']'
        prompt = system_prompt.for_codex(sys.executable, HIVE_MIND_CLI_PATH, self.is_admin,
            full_access=self.is_admin and self.permission_mode == 'auto' and not self.agent_auto,
            agent=bool(self.agent_id), computer_available=bool(self.session_id or self.agent_id),
            session_id=self.session_id or '', integration_ids=self.integration_ids).replace('Codex', 'Antigravity')
        prompt += projects.project_addendum(self.project_id) + '\n' + self.agent_prompt
        prior = session_manager.effective_messages(self.session_id, exclude_last=True)
        if prior:
            prompt += '\n[Earlier conversation:]\n' + '\n\n'.join(f'{m["role"]}: {sent_text(m)}' for m in prior)
        return f'[System instructions:]\n{prompt}\n{guidance}\n\n[User message:]\n{text}'

    async def _run_process(self, user_text):
        refusal = self._machine_refusal()
        if refusal:
            raise ValueError(refusal)
        executable = antigravity_cli.find_antigravity()
        if not executable:
            raise RuntimeError('Antigravity CLI (agy) was not found. Install it, sign in, and recheck Settings > Models.')
        args = self._build_args(executable)
        prompt = self._prompt(user_text)
        token = tool_access.issue(self.session_id, self.is_admin, self.agent_id, self.model,
                                 integration_ids=self.integration_ids, read_only=self.read_only)
        stderr_task = None
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(*args, cwd=self.cwd,
                env={**os.environ, 'JARVIS_TOOL_TOKEN': token, 'JARVIS_API_BASE': local_api_base()},
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=10 * 1024 * 1024, start_new_session=os.name != 'nt',
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self._proc = proc
            self._stop_confirmed = False
            stderr_task = asyncio.create_task(proc.stderr.read())
            if self._cancelled:
                return
            proc.stdin.write((json.dumps({'event': 'user', 'message': {'role': 'user', 'content': prompt}}) + '\n').encode('utf-8'))
            await proc.stdin.drain()
            proc.stdin.close()  # One turn per process: EOF is required on Windows too.
            async for event in self._consume_agy(proc, stderr_task):
                yield event
        finally:
            from core import chat_tasks
            chat_tasks.end_source(self.session_id, 'antigravity', 'Ended with the Antigravity turn')
            tool_access.revoke(token)
            if proc:
                self._stop_confirmed = await kill_tree(proc)
                if self._stop_confirmed:
                    self._proc = None
            if stderr_task:
                if not stderr_task.done():
                    stderr_task.cancel()
                await asyncio.gather(stderr_task, return_exceptions=True)

    async def _consume_agy(self, proc, stderr_task):
        opened, finished, step_usage = set(), set(), {}
        emitted_text = False
        terminal = None
        while True:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=600)
            except asyncio.TimeoutError:
                raise RuntimeError('Antigravity produced no stream output for 10 minutes and was stopped.') from None
            if not line:
                break
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get('event')
            payload = event.get(kind) if isinstance(event.get(kind), dict) else {}
            conversation = event.get('conversation_id') or payload.get('conversation_id')
            if conversation and self.thread_id is None:
                self.thread_id = conversation
                if self.session_id and not self._forge:
                    session_manager.set_antigravity_conversation_id(self.session_id, conversation)
            if kind == 'step_update':
                step = payload
                index = str(step.get('step_index', ''))
                step_type = step.get('step_type')
                if step_type not in ('user_input', 'agent_response', 'tool'):
                    logger.warning('Unknown Antigravity step_type: %r', step_type)
                if step.get('step_type') == 'agent_response' and isinstance(step.get('text_delta'), str):
                    emitted_text = True
                    yield runs.text(step['text_delta'])
                if step.get('state') == 'DONE' and isinstance(step.get('usage'), dict):
                    step_usage[index] = step['usage']
                tool = step.get('tool_info') if isinstance(step.get('tool_info'), dict) else {}
                name = step.get('tool_name') or tool.get('name')
                if name == 'ask_permission':
                    raise RuntimeError(APPROVAL_NOTICE)
                if name and index not in finished:
                    if index not in opened:
                        opened.add(index)
                        yield runs.tool_started(index, name, tool.get('parameters') or {})
                    if step.get('state') == 'DONE':
                        finished.add(index)
                        yield runs.tool_finished(index, not bool(tool.get('error')), tool.get('error') or tool.get('output') or '')
                if self.session_id and step.get('subagent_info'):
                    from core import chat_tasks
                    chat_tasks.antigravity_step(self.session_id, step)
            elif kind == 'error':
                raise RuntimeError(str(payload.get('message') or event.get('message') or 'Antigravity reported an error'))
            elif kind == 'result':
                terminal = payload
                if not emitted_text and isinstance(payload.get('response'), str):
                    yield runs.text(payload['response'])
        code = await asyncio.wait_for(proc.wait(), timeout=10)
        if self._cancelled:
            return
        stderr = await _stderr_tail(stderr_task)
        if antigravity_cli.auth_error(stderr + str((terminal or {}).get('error') or '')):
            raise RuntimeError(antigravity_cli.SIGN_IN)
        if (terminal and terminal.get('denied_actions')) or any(term in stderr.lower() for term in ('soft-denied', 'requires approval', 'permission denied')):
            raise RuntimeError(APPROVAL_NOTICE)
        if code or not terminal or terminal.get('status') != 'SUCCESS':
            detail = (terminal or {}).get('error') or stderr or 'No successful result was received.'
            raise RuntimeError(f'Antigravity could not complete this turn: {detail}')
        # Prefer this invocation's completed steps. Result usage is safe only
        # for a single-turn conversation; resumed counters may include history.
        measured = list(step_usage.values())
        if not measured and terminal.get('num_turns') == 1 and isinstance(terminal.get('usage'), dict):
            measured = [terminal['usage']]
        if measured:
            self.last_usage = {key: sum(u[key] for u in measured if isinstance(u.get(key), int))
                               for key in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'total_tokens')
                               if any(isinstance(u.get(key), int) for u in measured)}
            # agy cache reads are additional to its uncached input.
            self.last_usage['cache_read_input_tokens'] = self.last_usage.pop('cache_read_tokens', None)
            if any(isinstance(u.get('thinking_tokens'), int) for u in measured):
                self.last_usage['reasoning_output_tokens'] = sum(u.get('thinking_tokens', 0) for u in measured)
        usage = runs.usage_event(self.last_usage)
        if usage:
            yield usage
        yield runs.result(usage is not None, thread_id=self.thread_id)

    async def cancel(self):
        from core import codex_questions
        self._cancelled = True
        await codex_questions.clear(self.session_id)
        if self._proc:
            self._stop_confirmed = await kill_tree(self._proc)
        return runs.StopResult(self._stop_confirmed, 'Antigravity process tree stopped' if self._stop_confirmed else 'Antigravity stop could not be confirmed')
