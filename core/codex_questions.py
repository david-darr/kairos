"""Questions owned by a Codex chat turn, including tasks already taken to wait."""
import asyncio

_pending: dict[str, list[asyncio.Task]] = {}
_owned: dict[str, list[asyncio.Task]] = {}
_rounds: dict[str, int] = {}


def register(session_id, task):
    _pending.setdefault(session_id, []).append(task)
    _owned.setdefault(session_id, []).append(task)


def take(session_id):
    return _pending.pop(session_id, [])


def at_limit(session_id):
    return _rounds.get(session_id, 0) >= 8


def next_round(session_id):
    _rounds[session_id] = _rounds.get(session_id, 0) + 1


async def clear(session_id, *, reset_rounds=True):
    tasks = _owned.pop(session_id, [])
    _pending.pop(session_id, None)
    if reset_rounds:
        _rounds.pop(session_id, None)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
