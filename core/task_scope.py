"""Trusted owner identity for one admitted background run; never model input."""
import contextvars
from contextlib import contextmanager

_current = contextvars.ContextVar("task_owner_scope", default=None)


def owner_for(task):
    from core.auth import auth_enabled, SINGLE_USER
    if not auth_enabled():
        return SINGLE_USER
    values = [task[k] for k in ("owner_user", "owner", "user_id", "created_by") if task.get(k)]
    if any(not isinstance(v, str) for v in values):
        return None
    owners = set(values)
    if len(owners) > 1:
        return None
    if owners:
        return owners.pop()
    if task.get("origin_session_id"):
        from core.session_manager import session_manager
        return (session_manager.get_session(task["origin_session_id"]) or {}).get("owner_user")
    return None


@contextmanager
def bind(task):
    scope = {"task_id": task["id"], "agent_id": task.get("agent_id"), "owner": owner_for(task), "active": True}
    token = _current.set(scope)
    try:
        yield
    finally:
        scope["active"] = False
        _current.reset(token)


def current_owner(agent_id=None, task_id=None):
    scope = _current.get()
    if (not scope or not scope["active"] or scope["agent_id"] != agent_id
            or (task_id is not None and scope["task_id"] != task_id)):
        return None
    return scope["owner"]
