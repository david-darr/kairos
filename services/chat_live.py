"""Server-owned chat turns and a shared live feed for every open client.

The model task belongs to the backend, never to a browser response. A viewer
can leave, reconnect, or join from another device without stopping the turn.
"""
import asyncio
import contextlib
import hashlib
import json
import logging
import time
import uuid
from copy import deepcopy

from fastapi import HTTPException

from core import runs, mobile_activity
from core.auth import SINGLE_USER, auth_manager
from services import chat_service

logger = logging.getLogger(__name__)
_runs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}
_subscribers: set[asyncio.Queue] = set()
_FINISHED_SECONDS = 300


def require_session(session_id: str, user: str) -> dict:
    session = chat_service.session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if session.get("owner_user") != user and not auth_manager.is_admin(user):
        if session.get("owner_user") is not None or user != SINGLE_USER:
            raise HTTPException(404, "session not found")
    if session.get("forge") and not auth_manager.is_admin(user):
        raise HTTPException(404, "session not found")
    return session


def visible_packet(packet: dict, user: str) -> dict | None:
    def allowed(session_id):
        try:
            require_session(session_id, user)
            return True
        except HTTPException:
            return False
    if packet["type"] == "snapshot":
        return {**packet, "runs": {sid: run for sid, run in packet["runs"].items() if allowed(sid)}}
    return packet if allowed(packet["sessionId"]) else None


def _mobile_packet(packet: dict) -> None:
    # A durable notification projection of the live feed, never a second
    # executor or subscriber protocol. Failures cannot stop a model turn.
    try:
        mobile_activity.project_live(packet)
    except Exception:
        logger.error("Could not update mobile chat activity")


def _visible(run: dict) -> dict:
    return deepcopy({key: value for key, value in run.items() if key != "endedAt" and not key.startswith("_")})


def _prune() -> None:
    now = time.time()
    for session_id, run in list(_runs.items()):
        if run.get("endedAt") and now - run["endedAt"] > _FINISHED_SECONDS:
            _runs.pop(session_id, None)


def snapshot() -> dict:
    _prune()
    return {"type": "snapshot", "runs": {session_id: _visible(run) for session_id, run in _runs.items()}}


def subscribe() -> tuple[asyncio.Queue, dict]:
    # Register before taking the snapshot. Any turn update that follows it is
    # queued for this viewer, so joining never leaves a gap between the two.
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    _subscribers.add(queue)
    return queue, snapshot()


def unsubscribe(queue: asyncio.Queue) -> None:
    _subscribers.discard(queue)


def _broadcast(packet: dict) -> None:
    _mobile_packet(packet)
    for queue in tuple(_subscribers):
        if queue.full():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(snapshot())
        else:
            queue.put_nowait(packet)


def _update(session_id: str, run: dict, **changes) -> None:
    run.update(changes)
    run["revision"] += 1
    _broadcast({"type": "update", "sessionId": session_id, "turnId": run["turnId"],
                "revision": run["revision"], "changes": changes})


def _finish(session_id: str, run: dict, status: str, error: str | None = None) -> None:
    if run["status"] != "processing":
        return
    _update(session_id, run, status=status, stopping=False, permission=None, error=error)
    run["endedAt"] = time.time()


def _client_error(error: Exception) -> str:
    kind = chat_service.failure_kind(error)
    if kind == "rate_limited":
        return "The selected model is rate limited. Choose another model to retry."
    if kind == "request_error":
        return "The message could not be completed. Check its attachments and references before retrying."
    return "The selected model failed. Check its connection or choose another model. Any partial reply has been saved."


def start(session_id: str, text: str, attachment_ids: list[str], is_admin: bool,
          reference_context: str, references: list[dict], *, user: str = SINGLE_USER,
          request_id: str | None = None) -> dict:
    _prune()
    session = require_session(session_id, user)
    fingerprint = hashlib.sha256(json.dumps([text, attachment_ids, references], sort_keys=True).encode()).hexdigest()
    existing = mobile_activity.find_request(user, session_id, request_id) if request_id else None
    if existing:
        if existing["fingerprint"] != fingerprint:
            raise HTTPException(409, "This request ID was already used for a different message")
        return {"turn_id": existing["id"]}
    chat_service.claim_session(session_id)
    run = {"turnId": uuid.uuid4().hex, "sessionTitle": session.get("title") or "Chat",
           "prompt": text, "text": "", "startedAt": time.time(), "status": "processing",
           "stopping": False, "permission": None, "toolEvents": [], "toolSteps": [],
           "handoffs": None, "runId": None, "error": None, "revision": 1}
    _runs[session_id] = run
    try:
        mobile_activity.create_run(run["turnId"], session, user, request_id, fingerprint)
        task = asyncio.create_task(_run(session_id, run, attachment_ids, is_admin, reference_context, references))
    except Exception:
        chat_service.release_session(session_id)
        _runs.pop(session_id, None)
        raise
    _tasks[session_id] = task
    task.add_done_callback(lambda completed: _task_done(session_id, run, completed))
    _broadcast({"type": "started", "sessionId": session_id, "run": _visible(run)})
    return {"turn_id": run["turnId"]}


def _task_done(session_id: str, run: dict, task: asyncio.Task) -> None:
    # Also covers Stop arriving before the new task gets its first timeslice.
    if not run.get("_started"):
        chat_service.release_session(session_id)
    if _tasks.get(session_id) is task:
        _tasks.pop(session_id, None)
    if run["status"] == "processing":
        _finish(session_id, run, "stopped" if task.cancelled() else "failed",
                None if task.cancelled() else "The reply ended unexpectedly.")
    if not task.cancelled() and task.exception():
        logger.error("live chat task failed for %s", session_id, exc_info=task.exception())


async def _run(session_id: str, run: dict, attachment_ids: list[str], is_admin: bool,
               reference_context: str, references: list[dict]) -> None:
    run["_started"] = True
    try:
        stream = chat_service.stream_message(session_id, run["prompt"], attachment_ids, is_admin,
                                             reference_context, references, claimed=True)
        async with contextlib.aclosing(stream):
            async for item in stream:
                if run["permission"] and (isinstance(item, str) or
                                           isinstance(item, dict) and ("tool_step" in item or "handoffs" in item)):
                    _update(session_id, run, permission=None)
                context = runs.current_for(session_id)
                if context and run["runId"] != context.run_id:
                    _update(session_id, run, runId=context.run_id)
                if isinstance(item, str):
                    run["text"] += item
                    run["revision"] += 1
                    _broadcast({"type": "chunk", "sessionId": session_id,
                                "turnId": run["turnId"], "revision": run["revision"], "chunk": item})
                elif isinstance(item, dict):
                    if item.get("run_id") and run["runId"] != item["run_id"]:
                        _update(session_id, run, runId=item["run_id"])
                    for key, value in item.items():
                        if key == "permission":
                            _update(session_id, run, permission=value)
                        elif key == "permission_closed":
                            permission_answered(value)
                        elif key == "handoffs":
                            _update(session_id, run, handoffs=value)
                        elif key == "tool_event":
                            run["toolEvents"].append(value)
                            run["revision"] += 1
                            _broadcast({"type": "tool_event", "sessionId": session_id,
                                        "turnId": run["turnId"], "revision": run["revision"], "value": value})
                        elif key == "tool_step":
                            run["toolSteps"].append(value)
                            run["revision"] += 1
                            _broadcast({"type": "tool_step", "sessionId": session_id,
                                        "turnId": run["turnId"], "revision": run["revision"], "value": value})
        from core import session_manager_store
        failed = (session_manager_store.get_run(run["runId"]) or {}).get("outcome") == "failed" if run["runId"] else False
        _finish(session_id, run, "failed" if failed else "done")
    except asyncio.CancelledError:
        _finish(session_id, run, "stopped")
        raise
    except Exception as error:
        logger.exception("live chat failed for %s", session_id)
        _finish(session_id, run, "failed", _client_error(error))
    finally:
        chat_service.release_session(session_id)


def stop(session_id: str) -> bool:
    run = _runs.get(session_id)
    task = _tasks.get(session_id)
    if not run or not task or run["status"] != "processing":
        return False
    if not run["stopping"]:
        _update(session_id, run, stopping=True)
        task.cancel()
    return True


def permission_answered(request_id: str) -> None:
    for session_id, run in _runs.items():
        if run["status"] == "processing" and (run.get("permission") or {}).get("id") == request_id:
            _update(session_id, run, permission=None)


async def shutdown() -> None:
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
