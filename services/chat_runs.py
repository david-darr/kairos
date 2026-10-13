"""Host-owned chat execution. Disconnecting a subscriber never stops work."""
import asyncio
import contextlib
import hashlib
import json
import uuid

from fastapi import HTTPException
from core import mobile_activity as store, permissions, runs
from core import session_manager_store as session_store
from core.auth import SINGLE_USER, auth_manager
from core.session_manager import session_manager
from core import logs as log_files
from services import chat_service

_tasks: dict[str, asyncio.Task] = {}
_signals: dict[str, asyncio.Event] = {}


def require_session(session_id, user):
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if session.get("owner_user") != user and not auth_manager.is_admin(user):
        # Legacy ownerless sessions remain accessible only to the local
        # account/admin. Authentication alone does not grant chat access.
        if session.get("owner_user") is not None or user != SINGLE_USER:
            raise HTTPException(404, "session not found")
    if session.get("forge") and not auth_manager.is_admin(user):
        raise HTTPException(404, "session not found")
    return session


def require_run(run_id, user):
    record = store.read_run(run_id)
    if not record or (record["owner"] != user and not auth_manager.is_admin(user)):
        raise HTTPException(404, "run not found")
    require_session(record["session_id"], user)
    return record


async def start(session_id, user, message, attachment_ids, references, reference_context, request_id=None):
    session = require_session(session_id, user)
    fingerprint = hashlib.sha256(json.dumps([message, attachment_ids, references], sort_keys=True).encode()).hexdigest()
    existing = store.find_request(user, session_id, request_id)
    if existing:
        if existing["fingerprint"] != fingerprint:
            raise HTTPException(409, "This request ID was already used for a different message")
        return require_run(existing["id"], user)["snapshot"]
    # Reserve before scheduling the producer so a simultaneous start or a
    # transcript mutation cannot slip in before the task's first event.
    operation = chat_service.session_operation(session_id)
    await operation.__aenter__()
    run_id = uuid.uuid4().hex[:12]
    try:
        snapshot = store.create_run(run_id, session, user, request_id, fingerprint)
        _signals[run_id] = asyncio.Event()
        _tasks[run_id] = asyncio.create_task(_produce(run_id, operation, session_id, user, message,
                                                     attachment_ids, references, reference_context))
    except BaseException:
        await operation.__aexit__(None, None, None)
        raise
    return snapshot


def _publish(run_id, payload, state=None):
    snapshot = store.publish(run_id, payload, state)
    signal = _signals.get(run_id)
    if signal:
        signal.set()
    return snapshot


def _alert(run_id, kind, permission=None):
    # Notification persistence failure must not change the model's outcome.
    try:
        store.enqueue(run_id, kind, permission)
    except Exception:
        chat_service.logger.error("Could not queue mobile chat notification")


async def _produce(run_id, operation, session_id, user, message, attachment_ids, references, reference_context):
    tag = log_files.set_log_tag(session_id)
    run_token = runs.CHAT_RUN_ID.set(run_id)
    try:
        async with contextlib.aclosing(chat_service._stream_message(session_id, message, attachment_ids,
                                                                  auth_manager.is_admin(user), reference_context, references)) as stream:
            async for item in stream:
                payload = item if isinstance(item, dict) else {"chunk": item}
                _publish(run_id, payload)
                if "permission" in payload:
                    _alert(run_id, "permission", payload["permission"])
        # The service can translate a provider failure into a friendly reply;
        # inspect its canonical accounting instead of claiming success.
        failed = (session_store.get_run(run_id) or {}).get("outcome") == "failed"
        state = "failed" if failed else "completed"
        _publish(run_id, {"done": True, "state": state}, state)
        if not store.read_run(run_id)["snapshot"].get("handoffs"):
            _alert(run_id, state)
    except asyncio.CancelledError:
        _publish(run_id, {"done": True, "state": "stopped"}, "stopped")
    except Exception as error:
        kind = chat_service.failure_kind(error)
        message = ("The selected model is rate limited. Choose another model to retry." if kind == "rate_limited" else
                   "The message could not be completed. Check its attachments and references before retrying." if kind == "request_error" else
                   "The selected model failed. Check its connection or choose another model. Any partial reply has been saved.")
        _publish(run_id, {"error": message, "error_kind": kind, "done": True, "state": "failed"}, "failed")
        _alert(run_id, "failed")
    finally:
        runs.CHAT_RUN_ID.reset(run_token)
        log_files.reset_log_tag(tag)
        await operation.__aexit__(None, None, None)
        _tasks.pop(run_id, None)
        _signals.pop(run_id, None)


async def stop(run_id, user):
    record = require_run(run_id, user)
    task = _tasks.get(run_id)
    if task:
        # Let a newly scheduled producer enter its try/finally before cancel.
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    return store.read_run(run_id)["snapshot"]


def snapshot_for_client(record):
    snapshot = dict(record["snapshot"])
    # Never replay an expired/answered permission card.
    snapshot["permissions"] = permissions.pending_for(f"chat:{record['session_id']}") if record["state"] not in store.TERMINAL else []
    return snapshot


async def events(run_id, user, after=0, authorized=None):
    # On every connection start with a current snapshot. It replaces the
    # projection atomically: reconnects do not concatenate duplicate text.
    record = require_run(run_id, user)
    if authorized and not authorized():
        return
    snapshot = snapshot_for_client(record)
    cursor = snapshot["revision"]
    yield f"id: {cursor}\ndata: {json.dumps({'snapshot': snapshot})}\n\n"
    while record["state"] not in store.TERMINAL:
        if authorized and not authorized():
            return
        signal = _signals.get(run_id)
        if signal:
            signal.clear()
        record = require_run(run_id, user)
        pending = store.replay(run_id, cursor)
        if pending and pending[0][0] != cursor + 1:
            snapshot = snapshot_for_client(record)
            cursor = snapshot["revision"]
            yield f"id: {cursor}\ndata: {json.dumps({'snapshot': snapshot})}\n\n"
        else:
            for revision, payload in pending:
                cursor = revision
                yield f"id: {revision}\ndata: {json.dumps(payload)}\n\n"
        if record["state"] in store.TERMINAL:
            break
        try:
            await asyncio.wait_for(signal.wait() if signal else asyncio.sleep(1), timeout=15)
        except asyncio.TimeoutError:
            yield ": keepalive\n\n"


async def shutdown():
    # Shutdown is an interruption, not a browser disconnect. Never restart
    # side-effecting work automatically on the next boot.
    await asyncio.sleep(0)
    for task in list(_tasks.values()):
        task.cancel()
    await asyncio.gather(*list(_tasks.values()), return_exceptions=True)
