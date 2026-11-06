"""Bounded, persisted background work observed on model streams.

No service dependencies. Private transport metadata never leaves summary/detail.
"""
import asyncio
import logging
import json
import os
import re
import tempfile
import time
from copy import deepcopy

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.runs import clip_ends as _clip_ends

log = logging.getLogger(__name__)
KEYS = ('id', 'kind', 'source', 'label', 'status', 'activity', 'startedAt', 'endedAt', 'detail')
TERMINAL = {'done', 'failed', 'stopped'}
_sessions = {}
_listener = None
_pending = {}
_notified = {}


def clip_ends(value, limit):
    # runs.clip_ends keeps both ends and adds a three-character separator.
    # Include that separator in this registry's public field bounds.
    clipped = _clip_ends(value, limit)
    return _clip_ends(value, limit - 3) if len(clipped) > limit else clipped


def line(value, limit=120):
    return str(value or '').splitlines()[0][:limit] if str(value or '').splitlines() else ''


_files = {}  # session id -> the file it was loaded from, so a later save goes back to that account


def _path(sid):
    if sid in _files:
        return _files[sid]
    if isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9_-]+', sid):
        from core import accounts
        return os.path.join(accounts.path('chat_tasks'), sid + '.json')


def _save(sid):
    path = _path(sid)
    if path:
        try:
            write_json_atomic(path, _sessions[sid])
        except OSError:
            log.exception('Could not persist background work')


def _session(sid):
    if sid not in _sessions:
        path = _path(sid)
        if path:
            _files[sid] = path
        data = read_json(path, {}) if path else {}
        data.setdefault('items', {})
        data.setdefault('notes', [])
        data.setdefault('tools', {})
        _sessions[sid] = data
        changed = False
        for item in data['items'].values():
            if item['status'] == 'running':
                item.update(status='stopped', activity='Kairos restarted while this was running', endedAt=time.time())
                _note(data, item)
                changed = True
        if changed:
            _save(sid)
    return _sessions[sid]


def set_listener(callback):
    global _listener
    _listener = callback


def _emit(sid):
    _pending.pop(sid, None)
    _notified[sid] = time.monotonic()
    if _listener:
        try:
            _listener(sid)
        except Exception:
            log.exception('Background item listener failed')


def _changed(sid, immediate=True):
    data = _sessions[sid]
    now = time.time()
    if immediate or now - data.get('_saved', 0) >= 2:
        data['_saved'] = now
        _save(sid)
    if not _listener:
        return
    delay = .4 - (time.monotonic() - _notified.get(sid, 0))
    if delay <= 0:
        _emit(sid)
    elif sid not in _pending:
        try:
            _pending[sid] = asyncio.get_running_loop().call_later(delay, _emit, sid)
        except RuntimeError:
            _emit(sid)


def _note(data, item):
    at = item.get('endedAt') or time.time()
    if item['status'] not in TERMINAL or any(n['id'] == item['id'] and
            (not item['id'].startswith('card:') or round(n['at']) == round(at)) for n in data['notes']):
        return False
    data['notes'].append({**{k: item[k] for k in ('id', 'kind', 'source', 'label', 'status')},
                          'at': at})
    data['notes'] = data['notes'][-200:]
    return True


def add_note(sid, item_summary):
    if _note(_session(sid), item_summary):
        _changed(sid)


def notes(sid):
    return deepcopy(_session(sid)['notes'])


def _new(ident, kind, source, label='', detail='transcript'):
    return dict(id=ident, kind=kind, source=source, label=line(label), status='running',
                activity='', startedAt=None, endedAt=None, detail=detail)


def summary(item):
    return {k: item.get(k) for k in KEYS}


def items(sid):
    sweep(sid)
    now = time.time()
    values = _session(sid)['items'].values()
    values = [summary(i) for i in values if i.get('endedAt') is None or now - i['endedAt'] <= 1800]
    return sorted(values, key=lambda i: (i['status'] != 'running', -(i['endedAt'] or i['startedAt'] or 0)))[:30]


def _current_account_ids():
    """The loaded chats that belong to the current account: their file is in its chat_tasks folder
    (Multi-Account group 3), so the watcher's pass for one account never settles another's."""
    from core import accounts
    try:
        folder = os.path.normcase(os.path.abspath(accounts.path('chat_tasks')))
    except accounts.NoAccount:
        return []
    return [sid for sid in list(_sessions)
            if sid not in _files or os.path.normcase(os.path.abspath(os.path.dirname(_files[sid]))) == folder]


def sweep(sid=None):
    for session_id in ([sid] if sid else _current_account_ids()):
        data = _session(session_id)
        expired = [key for key, item in data['items'].items() if item.get('endedAt') is not None and time.time() - item['endedAt'] > 1800]
        for key in expired:
            del data['items'][key]
        changed = bool(expired)
        for item in data['items'].values():
            if item['status'] == 'running' and item.get('_missing') and time.time() - item['_missing'] >= 5:
                item.update(status='stopped', endedAt=time.time())
                _note(data, item)
                changed = True
        if changed:
            _changed(session_id)


def _get(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _status(status):
    return {'completed': 'done', 'failed': 'failed', 'stopped': 'stopped', 'killed': 'stopped',
            'pending': 'running', 'running': 'running'}.get(status)


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(_get(block, 'text') for block in content
                         if _get(block, 'type', 'text') == 'text' and isinstance(_get(block, 'text'), str))
    return ''


def _tool_summary(inp):
    return next((inp[k] for k in ('file_path', 'path', 'command', 'pattern', 'query', 'url', 'description')
                 if isinstance(inp.get(k), str)), json.dumps(inp, ensure_ascii=False, separators=(',', ':')))


def claude_message(sid, message):
    try:
        _claude(sid, message)
    except Exception:
        log.exception('Ignoring malformed Claude background message')


def _claude(sid, message):
    sweep(sid)
    data = _session(sid)
    raw = _get(message, 'data', {}) or {}
    def get(key, default=None):
        return _get(message, key, raw.get(key, default))
    cls = type(message).__name__
    changed = False
    immediate = False
    if get('subtype') == 'background_tasks_changed':
        present = set()
        for task in raw.get('tasks', []):
            ident = 'claude:' + task['task_id']
            present.add(ident)
            if ident not in data['items']:
                kind = {'local_agent': 'subagent', 'local_bash': 'command'}.get(task.get('task_type'), 'task')
                data['items'][ident] = _new(ident, kind, 'claude', task.get('description'),
                                                   'output' if kind == 'command' else 'transcript')
                data['items'][ident]['_background'] = True
            data['items'][ident].pop('_missing', None)
        for ident, item in data['items'].items():
            if item['source'] == 'claude' and item['status'] == 'running' and item.get('_background') and ident not in present:
                item.setdefault('_missing', time.time())
        changed = immediate = True
    if cls in ('TaskStartedMessage', 'TaskProgressMessage', 'TaskNotificationMessage', 'TaskUpdatedMessage'):
        task_id = get('task_id')
        if not task_id:
            return
        ident = 'claude:' + str(task_id)
        tool = data['tools'].get(get('tool_use_id'), {})
        inp = tool.get('input', {})
        kind = {'local_agent': 'subagent', 'local_bash': 'command'}.get(get('task_type'),
                  'command' if tool.get('name') == 'Bash' else 'subagent' if tool.get('name') in ('Agent', 'Task') else 'task')
        item = data['items'].setdefault(ident, _new(ident, kind, 'claude', get('description'),
                                                   'output' if kind == 'command' else 'transcript'))
        if cls == 'TaskStartedMessage':
            item.update(kind=kind, detail='output' if kind == 'command' else 'transcript',
                        label=line(inp.get('description') or get('description') or inp.get('command')),
                        startedAt=time.time(), _background=bool(get('is_backgrounded', False)),
                        _tool_use_id=get('tool_use_id'), prompt=clip_ends(inp.get('prompt') or get('prompt') or '', 4000),
                        command=clip_ends(inp.get('command', ''), 2000))
            item.pop('_missing', None)
            if tool.get('_output_file'):
                item['_output_file'] = tool['_output_file']
        elif cls == 'TaskProgressMessage':
            item['activity'] = line(get('description'), 160)
        elif cls == 'TaskNotificationMessage':
            item['summary'] = clip_ends(get('summary', ''), 4000)
            item['activity'] = line(get('summary'), 160)
        patch = get('patch', {}) or {}
        status = _status(patch.get('status') or get('status'))
        if status:
            item['status'] = status
        if patch.get('end_time') is not None:
            item['endedAt'] = patch['end_time'] / 1000
        if item['status'] in TERMINAL:
            item['endedAt'] = item['endedAt'] or time.time()
            _note(data, item)
        if get('output_file'):
            item['_output_file'] = get('output_file')
        usage = get('usage')
        if isinstance(usage, dict):
            item['usage'] = {k: usage[k] for k in ('total_tokens', 'tool_uses', 'duration_ms') if isinstance(usage.get(k), (int, float))}
        changed = True
        immediate = cls != 'TaskProgressMessage'
    parent = get('parent_tool_use_id')
    parent_item = next((i for i in data['items'].values() if parent and i.get('_tool_use_id') == parent), None)
    for block in get('content', []) or []:
        name = _get(block, 'name')
        inp = _get(block, 'input', {}) or {}
        bid = _get(block, 'id')
        if name in ('Agent', 'Task', 'Bash') and bid and not parent:
            data['tools'][bid] = {'name': name, 'input': {k: clip_ends(inp[k], limit) for k, limit in (('description', 120), ('command', 2000), ('prompt', 4000)) if k in inp}}
            data['tools'] = dict(list(data['tools'].items())[-100:])
        result_id = _get(block, 'tool_use_id')
        if result_id and not parent and data['tools'].get(result_id, {}).get('name') == 'Bash':
            text = _text(_get(block, 'content', ''))
            match = re.search(r'Output is being written to:\s*(.+?\.output)(?:\.|\s|$)', text)
            if match:
                data['tools'].setdefault(result_id, {})['_output_file'] = match.group(1)
                changed = True
                for i in data['items'].values():
                    if i.get('_tool_use_id') == result_id:
                        i['_output_file'] = match.group(1)
                        changed = True
        if parent_item:
            kind = 'tool' if name else 'result' if result_id else 'text'
            text = _tool_summary(inp) if name else _get(block, 'text') or _text(_get(block, 'content', ''))
            if text:
                parent_item.setdefault('steps', []).append({'at': time.time(), 'kind': kind, 'name': name or '', 'text': clip_ends(text, 600)})
                parent_item['steps'] = parent_item['steps'][-60:]
                if name:
                    parent_item['activity'] = line(name + ': ' + str(text), 160)
                changed = True
    if changed:
        _changed(sid, immediate)


def codex_item(sid, item, phase):
    try:
        _codex_item(sid, item, phase)
    except Exception:
        log.exception('Ignoring malformed Codex background item')


def _codex_item(sid, item, phase):
    if not isinstance(item, dict) or item.get('type') != 'collab_tool_call':
        return
    data = _session(sid)
    states = item.get('agents_states') or {}
    receivers = item.get('receiver_thread_ids') or []
    if not isinstance(states, dict) or not isinstance(receivers, list):
        return
    for thread in receivers:
        if not isinstance(thread, str):
            continue
        ident = 'codex:' + thread
        entry = data['items'].setdefault(ident, _new(ident, 'subagent', 'codex', item.get('prompt')))
        if item.get('prompt'):
            entry.update(prompt=clip_ends(item['prompt'], 4000), label=line(item['prompt']))
        state = states.get(thread) or {}
        if not isinstance(state, dict):
            continue
        status = {'pending_init': 'running', 'running': 'running', 'completed': 'done', 'errored': 'failed',
                  'not_found': 'failed', 'shutdown': 'stopped', 'interrupted': 'stopped'}.get(state.get('status'))
        if status:
            entry['status'] = status
        if state.get('message') is not None:
            entry.update(message=clip_ends(state['message'], 4000), activity=line(state['message'], 160))
        if entry['status'] in TERMINAL:
            entry['endedAt'] = entry['endedAt'] or time.time()
            _note(data, entry)
    _changed(sid)


def antigravity_step(sid, step):
    """Only metadata emitted by agy: no transcript/log URI is opened.

    A DONE spawn step is not proof a child completed. Without a reported
    child status the turn cleanup labels it stopped, just as Codex does.
    """
    info = step.get('subagent_info')
    if not isinstance(info, dict):
        return
    data = _session(sid)
    for child in info.get('subagents') or []:
        if not isinstance(child, dict) or not isinstance(child.get('conversation_id'), str):
            continue
        ident = 'antigravity:' + child['conversation_id']
        entry = data['items'].setdefault(ident, _new(ident, 'subagent', 'antigravity', child.get('role') or child.get('type_name')))
        status = {'running': 'running', 'completed': 'done', 'failed': 'failed', 'stopped': 'stopped'}.get(str(child.get('status', '')).lower())
        if status:
            entry['status'] = status
            if status in TERMINAL:
                entry['endedAt'] = entry['endedAt'] or time.time()
                _note(data, entry)
    _changed(sid)


def end_source(sid, source, reason):
    if not sid:
        return
    data = _session(sid)
    for item in data['items'].values():
        if item['source'] == source and item['status'] == 'running':
            item.update(status='stopped', endedAt=time.time(), activity=line(reason, 160))
            _note(data, item)
    _changed(sid)


def output_tail(path, *, with_truncation=False):
    try:
        root = os.path.normcase(os.path.realpath(tempfile.gettempdir()))
        actual = os.path.normcase(os.path.realpath(path))
        if os.path.commonpath([root, actual]) != root or not actual.endswith('.output') or not os.path.isfile(actual):
            return None
        with open(actual, 'rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            stream.seek(max(0, size - 16384))
            text = stream.read(16384).decode('utf-8', errors='replace')
        text = re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[ -/]*[@-~])', '', text)
        text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
        return (text, size > 16384) if with_truncation else text
    except (OSError, ValueError, TypeError):
        return None


def detail(sid, ident):
    item = _session(sid)['items'].get(ident)
    if not item or not any(i['id'] == ident for i in items(sid)):
        return None
    result = {'item': summary(item)}
    if item['kind'] == 'command':
        tail = output_tail(item.get('_output_file'), with_truncation=True)
        output, truncated = tail if tail is not None else (None, False)
        result.update(command=item.get('command', ''), output=output,
                      outputTruncated=truncated,
                      outputNote='Showing the last 16 KB' if truncated else '' if output is not None else 'Output is not available')
    elif item['source'] == 'codex':
        result.update(prompt=item.get('prompt', ''), message=item.get('message', ''))
    else:
        result.update(prompt=item.get('prompt', ''), steps=deepcopy(item.get('steps', [])),
                      summary=item.get('summary', ''), usage=deepcopy(item.get('usage', {})))
    return result


def forget(sid):
    _sessions.pop(sid, None)
    handle = _pending.pop(sid, None)
    if handle:
        handle.cancel()
    path = _path(sid)
    _files.pop(sid, None)
    if path and os.path.exists(path):
        os.remove(path)


def background_ids(sid):
    return {i['id'] for i in _session(sid)['items'].values()
            if i['source'] == 'claude' and i['status'] == 'running' and i.get('_background')}
