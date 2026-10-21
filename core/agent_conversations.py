"""Per-person chat organization; previews use real existing agent sessions."""
import os
import threading
from core.constants import DATA_DIR
from core.atomic_io import read_json, write_json_atomic

FILE = os.path.join(DATA_DIR, 'agent_conversations.json')
_LOCK = threading.RLock()


def preferences(user):
    with _LOCK:
        return read_json(FILE, {}).get(user, {})


def change(user, key, action, message_count=0, session_id=None):
    if action not in {'pin', 'unpin', 'read', 'unread'}:
        raise ValueError('Choose pin, unpin, read or unread')
    with _LOCK:
        data = read_json(FILE, {})
        entry = data.setdefault(user, {}).setdefault(key, {})
        if action in {'pin', 'unpin'}:
            entry['pinned'] = action == 'pin'
        else:
            entry['unread'] = action == 'unread'
            if action == 'read':
                entry['read_count'] = message_count
                entry['session_id'] = session_id
        write_json_atomic(FILE, data)
        return entry.copy()


def agent_threads(user, agents):
    from core.session_manager import session_manager
    saved = preferences(user)
    result = []
    for agent in agents:
        sessions = session_manager.list_sessions(agent_id=agent['id'])
        latest = max(sessions, key=lambda item: item.get('updated_at', 0), default=None)
        session = session_manager.get_session(latest['id']) if latest else None
        messages = [m for m in (session or {}).get('messages', []) if m.get('role') in {'user','assistant'}]
        pref = saved.get('agent:' + agent['id'], {})
        last = messages[-1] if messages else {}
        same_session = pref.get('session_id') == (latest or {}).get('id')
        baseline = pref.get('read_count', 0) if same_session else 0
        if 'read_count' not in pref: baseline = len(messages)
        unread = sum(m.get('role') == 'assistant' for m in messages[baseline:])
        result.append({'id': agent['id'], 'session_id': latest['id'] if latest else None,
                       'preview': str(last.get('content') or '')[:240], 'last_role': last.get('role'),
                       'at': last.get('ts') or (latest or {}).get('updated_at', 0),
                       'message_count': len(messages), 'pinned': bool(pref.get('pinned')),
                       'unread': max(unread, int(bool(pref.get('unread'))))})
    return {'agents': result, 'preferences': saved}
