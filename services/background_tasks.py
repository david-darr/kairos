"""Owner-only read model over stream work and existing Kairos executors."""
import asyncio
import json
import logging
import time
from collections import defaultdict
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import HTTPException
from core import accounts, chat_tasks, helpers, session_manager_store as store
from core.auth import SINGLE_USER, auth_manager
from core.runs import clip_ends

log = logging.getLogger(__name__)
_derived = {}
_details = {}
_broadcasts = {}
_sent_notes = {}
_task = None
_tick_sources = None
_account_of = {}  # session id -> the account whose chats hold it (Multi-Account group 3)


def require_owner(sid, user):
    from services.chat_live import require_session
    session = require_session(sid, user)
    owner = session.get('owner_user')
    if (owner is not None and owner != user) or (owner is None and user != SINGLE_USER and not auth_manager.is_admin(user)):
        raise HTTPException(404, 'session not found')
    return session


def owner_allowed(sid, user):
    try:
        require_owner(sid, user)
        return True
    except HTTPException:
        return False


def _seconds(value):
    if isinstance(value, (int, float)):
        return value
    try:
        return datetime.fromisoformat(value).timestamp() if value else None
    except (TypeError, ValueError):
        return None


def _source_groups():
    """One bounded source pass, shared by all chats on a watcher tick.

    Receipts are already in memory. Only their timestamps are used here;
    outputs and persisted timelines belong to detail().
    """
    from services.task_service import task_service
    from services import agent_handoff
    from services.forge_apps import forge_apps
    from core.computer import manager
    cutoff = time.time() - 1800
    groups = defaultdict(lambda: dict(helpers=[], cards=[], computers=[], apps=[]))
    with store.transaction() as conn:
        rows = conn.execute("SELECT id,parent,goal,status,started_at,ended_at FROM helpers "
                            "WHERE parent LIKE 'chat:%' AND (status IN ('waiting','running') OR ended_at >= ?)", (cutoff,))
        for row in rows:
            groups[row['parent'][5:]]['helpers'].append(dict(row))
    latest = {}
    for receipt in task_service._runs:
        ident = receipt['task_id']
        if (receipt.get('ran_at') or 0) >= (latest.get(ident, {}).get('ran_at') or 0):
            latest[ident] = {k: receipt.get(k) for k in ('ran_at', 'started_at', 'outcome')}
    for card in task_service.list_tasks():
        is_card = card.get('schedule_kind') == 'card'
        sid = ((agent_handoff.requester(card) or {}).get('session_id') or card.get('origin_session_id'))
        if not sid:
            continue
        receipt = latest.get(card['id'], {})
        comments = card.get('comments') or []
        end = max(filter(None, (_seconds(card.get('updated_at')), _seconds(card.get('created_at')),
                               _seconds(comments[-1].get('at')) if comments else None, receipt.get('ran_at'))), default=0)
        active = card.get('status') in ('backlog', 'ready', 'running') if is_card else bool(card.get('enabled'))
        if active or end >= cutoff:
            groups[sid]['cards'].append((card, receipt, end))
    for computer in manager.running():
        if computer.get('owner', '').startswith('chat:'):
            groups[computer['owner'][5:]]['computers'].append(computer)
    for sid in forge_apps.records:
        app = forge_apps.status(sid)
        ident = f"forge-app:{sid}:{int(app.get('started_at') or 0)}"
        previous = _derived.get(sid, {}).get(ident, {})
        end = app.get('ended_at') or previous.get('endedAt') or app.get('started_at')
        if app.get('running') or app.get('exit_code') is None or previous.get('status') == 'running' or (_seconds(end) or 0) >= cutoff:
            groups[sid]['apps'].append(app)
    return groups


def _derive(sid, sources=None):
    from services.agent_service import agent_service
    from services import agent_handoff
    from core.task_scheduler import run_in_progress
    previous = _derived.get(sid, {})
    found, details = {}, {}
    if sources is None:
        sources = _source_groups().get(sid, dict(helpers=[], cards=[], computers=[], apps=[]))

    def add(ident, kind, source, label, state, activity='', start=None, end=None, view='result', **detail):
        old = previous.get(ident, {})
        end = _seconds(end)
        if state in chat_tasks.TERMINAL and end is None:
            end = old.get('endedAt') or time.time()
        item = dict(id=ident, kind=kind, source=source, label=chat_tasks.line(label), status=state,
                    activity=chat_tasks.line(activity, 160), startedAt=_seconds(start), endedAt=end, detail=view)
        found[ident] = item
        details[ident] = {'item': item, **detail}

    for row in sources['helpers']:
        status = {'waiting': 'queued', 'running': 'running', 'done': 'done', 'stopped': 'stopped'}.get(row['status'], 'failed')
        add('helper:' + row['id'], 'helper', 'kairos', row.get('goal'), status,
            '', row.get('started_at'), row.get('ended_at'))

    for card, receipt, updated in sources['cards']:
        ident = card['id']
        if card.get('schedule_kind') == 'card':
            if ((agent_handoff.requester(card) or {}).get('session_id') or card.get('origin_session_id')) != sid:
                continue
            status = {'backlog': 'queued', 'ready': 'queued', 'running': 'running', 'review': 'done', 'done': 'done', 'blocked': 'failed'}.get(card.get('status'), 'queued')
            if status != 'failed' and agent_service.open_items_for_card(ident):
                status = 'waiting'
            agent = agent_service.get(card.get('agent_id')) or {}
            comments = card.get('comments') or []
            last = comments[-1] if comments else {}
            activity = last.get('text', '') if last.get('kind') not in ('result', 'error') else ''
            kind = 'agent' if card.get('agent_id') else 'task'
            label = f"{agent.get('name') or 'Agent'}: {card.get('name') or ''}" if kind == 'agent' else card.get('name')
            add('card:' + ident, kind, 'kairos', label, status,
                activity, card.get('run_started_at') or receipt.get('started_at'),
                updated if status in chat_tasks.TERMINAL else None, view='timeline',
                agent=agent.get('name') or '', card=card.get('name') or '', status=card.get('status'))
        elif card.get('origin_session_id') == sid:
            if not card.get('enabled'):
                if card.get('schedule_kind') == 'once' and receipt and receipt.get('outcome') != 'running':
                    status = 'failed' if receipt.get('outcome') in ('failed', 'lost') else 'stopped' if receipt.get('outcome') == 'stopped' else 'done'
                    add('task:' + ident, 'scheduled', 'kairos', card['name'], status, '',
                        receipt.get('started_at'), receipt.get('ran_at'))
                continue
            running = run_in_progress(ident)
            next_at = _seconds(card.get('next_run_at'))
            activity = ('Next run ' + datetime.fromtimestamp(next_at).strftime('%b %d, %H:%M')) if next_at is not None and not running else ''
            add('task:' + ident, 'scheduled', 'kairos', card['name'], 'running' if running else 'scheduled', activity,
                card.get('run_started_at') if running else None)

    for computer in sources['computers']:
        if computer.get('owner') != 'chat:' + sid:
            continue
        last = next((step.get('label') for step in reversed(computer.get('steps', [])) if isinstance(step, dict) and step.get('label')), '')
        activity = 'You have control' if computer.get('taken_over') else (last or computer.get('title') or urlsplit(computer.get('url') or '').hostname or '')
        add(f"computer:{sid}:{int(computer.get('started_at') or 0)}", 'computer', 'kairos', 'Computer', 'waiting' if computer.get('taken_over') else 'running',
            activity, computer.get('started_at'), view='computer', url=computer.get('url'), title=computer.get('title'))
    for computer_id, old in previous.items():
        if old['kind'] == 'computer' and computer_id not in found:
            add(computer_id, 'computer', 'kairos', 'Computer', 'done', 'Closed', old.get('startedAt'), old.get('endedAt'),
                view='computer', url=None, title='', steps=[])

    for app in sources['apps']:
        status = 'running' if app.get('running') or app.get('exit_code') is None else 'failed' if app.get('exit_code') else 'done'
        add(f"forge-app:{sid}:{int(app.get('started_at') or 0)}", 'app_server', 'forge', app.get('command'), status, app.get('url'), app.get('started_at'),
            end=app.get('ended_at'), view='logs', command=clip_ends(app.get('command') or '', 2000), url=app.get('url'))
    for ident, old in previous.items():
        if old['kind'] == 'app_server' and old['status'] in chat_tasks.TERMINAL and ident not in found:
            found[ident] = old
            details[ident] = _details.get(sid, {}).get(ident, {'item': old})

    now = time.time()
    found = {k: v for k, v in found.items() if v['endedAt'] is None or now - v['endedAt'] <= 1800}
    _derived[sid], _details[sid] = found, {k: v for k, v in details.items() if k in found}
    for item in found.values():
        if item['kind'] != 'scheduled' or item['status'] in chat_tasks.TERMINAL:
            chat_tasks.add_note(sid, item)
    return list(found.values())


def list_items(sid, sources=None):
    stream = chat_tasks.items(sid)
    derived = _derive(sid, sources)
    return sorted(stream + derived, key=lambda i: (i['status'] not in ('running', 'queued', 'waiting'), -(i['endedAt'] or i['startedAt'] or 0)))[:30]


def detail(sid, ident):
    if not any(item['id'] == ident for item in list_items(sid)):
        return None
    result = chat_tasks.detail(sid, ident)
    if result:
        return result
    result = dict(_details.get(sid, {}).get(ident) or {})
    if ident.startswith(('card:', 'task:')):
        from services.task_service import task_service
        task_id = ident.split(':', 1)[1]
        receipts = task_service.list_runs(task_id)
        receipt = receipts[0] if receipts else {}
        output = clip_ends(receipt.get('error') or receipt.get('output') or '', 4000)
        if ident.startswith('card:'):
            records = store.find_runs(task_id=task_id, limit=1)
            events = store.run_events(records[0]['id']) if records else []
            result.update(timeline=[{k: e.get(k) for k in ('at', 'kind', 'name', 'ok', 'detail', 'seconds')} for e in events], output=output)
        else:
            result['text'] = output
    elif ident.startswith('helper:'):
        rows = helpers._rows('id = ? AND parent = ?', (ident.split(':', 1)[1], 'chat:' + sid))
        if rows:
            result['text'] = clip_ends(rows[0].get('error') or rows[0].get('result') or '', 4000)
    elif ident.startswith('forge-app:'):
        from services.forge_apps import forge_apps
        app = forge_apps.status(sid) if sid in forge_apps.records else {}
        if int(app.get('started_at') or 0) == int(ident.rsplit(':', 1)[1]):
            result['lines'] = forge_apps.logs(sid, 200).get('lines', [])
    elif ident.startswith('computer:'):
        from core.computer import manager
        computer = next((c for c in manager.running() if c.get('owner') == 'chat:' + sid and
                         int(c.get('started_at') or 0) == int(ident.rsplit(':', 1)[1])), {})
        result['steps'] = [str(step['label']) for step in computer.get('steps', [])
                           if isinstance(step, dict) and step.get('label')][-20:]
    return result or None


def _broadcast(sid, sources=None):
    from services.chat_live import broadcast_owner
    # Mark before computing derived notes, whose listener may reenter here.
    if _broadcasts.get(sid) == 'computing':
        return
    previous = _broadcasts.get(sid)
    _broadcasts[sid] = 'computing'
    try:
        _account_of[sid] = accounts.effective_account()
    except accounts.NoAccount:
        pass
    try:
        if sources is None and _tick_sources is not None:
            sources = _tick_sources.get(sid, dict(helpers=[], cards=[], computers=[], apps=[]))
        items = list_items(sid, sources)
        notes = chat_tasks.notes(sid)
        fingerprint = json.dumps([items, notes], sort_keys=True)
        _broadcasts[sid] = fingerprint
        if fingerprint != previous:
            sent = _sent_notes.setdefault(sid, set())
            fresh = [n for n in notes if (n['id'], round(n['at'])) not in sent]
            broadcast_owner({'type': 'bg_tasks', 'sessionId': sid, 'items': items, 'notes': fresh})
            _sent_notes[sid] = {(n['id'], round(n['at'])) for n in notes}
    except Exception:
        _broadcasts[sid] = previous
        log.exception('Could not broadcast background work')


def _forget_sid(sid):
    for table in (_derived, _details, _broadcasts, _sent_notes, _account_of):
        table.pop(sid, None)


def _tick(account_id):
    """One watcher pass over one account's chats. Every account has its own chat database, so a chat
    only counts as gone when the account that showed it no longer has it."""
    global _tick_sources
    try:
        groups = _source_groups()
        _tick_sources = groups
        chat_tasks.sweep()  # this account's chats, sharing this pass's sources
        cutoff = time.time() - 1800
        candidates = {sid for sid, source in groups.items() if
                      source['helpers'] or source['computers'] or source['apps'] or
                      any(card.get('enabled') or card.get('schedule_kind') == 'card' or card.get('run_started_at') or
                          (not card.get('enabled') and (receipt.get('ran_at') or 0) >= cutoff)
                          for card, receipt, end in source['cards'])}
        for sid, items in list(_derived.items()):
            if _account_of.get(sid, account_id) != account_id:
                continue
            if any(i['status'] in ('running', 'queued', 'waiting') or (i.get('endedAt') or 0) >= cutoff for i in items.values()):
                candidates.add(sid)
            elif sid not in candidates:
                _forget_sid(sid)
        for sid in candidates:
            if store.session_exists(sid):
                _broadcast(sid, groups.get(sid, dict(helpers=[], cards=[], computers=[], apps=[])))
            elif _account_of.get(sid) == account_id:
                _forget_sid(sid)
    except Exception:
        log.exception('Background work watcher failed')
    finally:
        _tick_sources = None


async def _watch():
    while True:
        for account_id in accounts.all_accounts():
            with accounts.as_account(account_id):
                _tick(account_id)
        await asyncio.sleep(2)


def start():
    global _task
    chat_tasks.set_listener(_broadcast)
    if _task is None or _task.done():
        _task = asyncio.create_task(_watch())


async def stop():
    global _task
    chat_tasks.set_listener(None)
    if _task:
        _task.cancel()
        await asyncio.gather(_task, return_exceptions=True)
        _task = None
