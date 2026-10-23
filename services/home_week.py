"""Owner-scoped weekly Home activity, grouped by server-local calendar days."""
from datetime import date, datetime, time, timedelta
import json
import re

from core import session_manager_store as store
from core.atomic_io import read_json
from core.auth import SINGLE_USER
from services.task_service import TASKS_FILE, TASK_RUNS_FILE


def home_week(user: str, week: str | None = None) -> dict:
    if week is not None:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week):
            raise ValueError("week must be YYYY-MM-DD")
        day = date.fromisoformat(week)
    else:
        day = date.today()
    start = day - timedelta(days=day.weekday())
    end = start + timedelta(days=7)
    # Construct each local midnight rather than adding 168 hours across DST.
    lower = datetime.combine(start, time.min).timestamp()
    upper = datetime.combine(end, time.min).timestamp()
    slots = [{"date": (start + timedelta(days=i)).isoformat(), "half": half,
              "chats": 0, "agent_runs": 0} for i in range(7) for half in ("am", "pm")]

    def slot_of(stamp):
        if not isinstance(stamp, (int, float)) or not lower <= stamp < upper:
            return None
        local = datetime.fromtimestamp(stamp)
        return slots[(local.date() - start).days * 2 + (local.hour >= 12)]

    with store.transaction() as conn:
        sessions = {row['id']: json.loads(row['doc']) for row in conn.execute('SELECT id, doc FROM sessions')}
        messages = conn.execute("SELECT DISTINCT session_id, ts FROM messages WHERE role = 'user' AND ts >= ? AND ts < ?",
                                (lower, upper)).fetchall()

    def owns_session(sid):
        session = sessions.get(sid)
        return session is not None and (session.get('owner_user') == user or
                                       (session.get('owner_user') is None and user == SINGLE_USER))

    seen = set()
    for message in messages:
        if not owns_session(message['session_id']):
            continue
        slot = slot_of(message['ts'])
        key = (message['session_id'], slot['date'], slot['half'])
        if key not in seen:
            seen.add(key)
            slot['chats'] += 1

    # This is one row per execution, including live runs. Model telemetry can
    # contain several runs for one routine, so counting it would double-count.
    tasks = read_json(TASKS_FILE, {})
    unavailable = ['notes_done']  # Notes have updated_at, not completed_at, and no owner.
    missing_start = False
    for run in read_json(TASK_RUNS_FILE, []):
        task = tasks.get(run.get('task_id'), {})
        owner = next((task.get(k) for k in ('owner_user', 'owner', 'user_id', 'created_by') if task.get(k)), None)
        owned = owner == user if owner else owns_session(task.get('origin_session_id'))
        if not owned:
            continue  # Shared/ownerless bots and deleted routines cannot be attributed.
        stamp = run.get('started_at')
        if stamp is None:
            # Queued/skipped work never started. Old finished records have no
            # reliable start; ran_at is a finish time and must not stand in.
            if (run.get('outcome') not in ('queued', 'missed', 'skipped')
                    and not run.get('admitted_at')
                    and (run.get('ran_at') is None or run['ran_at'] >= lower)):
                missing_start = True
            continue
        slot = slot_of(stamp)
        if slot is not None:
            slot['agent_runs'] += 1
    if missing_start:
        unavailable.append('agent_runs')
        for slot in slots:
            slot['agent_runs'] = 0
    totals = {key: sum(slot[key] for slot in slots) for key in ('chats', 'agent_runs')}
    totals['notes_done'] = 0
    daily = [sum(slot['chats'] + slot['agent_runs'] for slot in slots[i:i + 2]) for i in range(0, 14, 2)]
    busiest = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')[daily.index(max(daily))] if any(daily) else None
    return {'start': start.isoformat(), 'end': (end - timedelta(days=1)).isoformat(),
            'slots': slots, 'totals': totals, 'busiest': busiest, 'unavailable': unavailable}
