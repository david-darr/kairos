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

from core import runs, mobile_activity, permissions
from core.auth import SINGLE_USER, auth_manager
from services import chat_service

logger = logging.getLogger(__name__)
_runs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}
_subscribers: set[asyncio.Queue] = set()
_FINISHED_SECONDS = 300
_HEARTBEAT_SECONDS = 10  # a tiny packet while any run is active; the client calls 30 s of silence lost contact
_WAIT_NOTICE_SECONDS = 60  # no reply text this long: ask Ollama whether the model is loading or working
_DETAIL_SECONDS = 10  # at most one /api/ps check per run this often
_ticker: asyncio.Task | None = None


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


def visible_packet(packet: dict, user: str, app_window: bool = False) -> dict | None:
    def allowed(session_id):
        try:
            require_session(session_id, user)
            return True
        except HTTPException:
            return False
    if packet['type'] == 'heartbeat':
        return packet
    if packet['type'] in ('bg_tasks', 'bg_followup'):
        from services.background_tasks import owner_allowed
        return packet if owner_allowed(packet.get('sessionId'), user) else None
    if packet["type"] in APP_ONLY_PACKETS:
        # Terminal pairing prompts (core/cli_access.py) go to the app window
        # alone; a paired terminal never sees, let alone answers, the next one.
        return packet if app_window else None
    if packet["type"] == "design_changed":
        # The Design canvas's live redraw (routes/design_routes.py): seen by
        # whoever may see that design, whether or not a chat changed it.
        from core import design_store
        try:
            data = design_store.manifest(packet["designId"])
        except LookupError:
            return None
        return packet if design_store.visible_to(data, user, auth_manager.is_admin(user)) else None
    if packet["type"] == "snapshot":
        visible = {**packet, "runs": {sid: run for sid, run in packet["runs"].items() if allowed(sid)}}
        if app_window:
            from core import cli_access
            visible["cliPairs"] = cli_access.pending_pairs()
        return visible
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


def agent_activity(agent_id: str) -> dict | None:
    """Bounded read-only activity for the admin agent summary, without transcripts."""
    active = []
    for session_id, run in list(_runs.items()):
        if run.get("status") != "processing":
            continue
        session = chat_service.session_manager.get_session(session_id)
        if session and session.get("agent_id") == agent_id:
            active.append(run)
    if not active:
        return None
    latest = max(active, key=lambda run: run.get("startedAt", 0))
    return {"kind": "chat", "working": True, "waiting": any(bool(run.get("permission")) for run in active),
            "name": str(latest.get("sessionTitle") or "Conversation")[:120],
            "detail": str(latest.get("prompt") or "")[:240], "count": len(active)}


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


APP_ONLY_PACKETS = ("cli_pair", "cli_pair_closed")


def broadcast_app(packet: dict) -> None:
    """A packet for the app window only (see visible_packet). Not a chat turn,
    so it skips the phone notification projection."""
    for queue in tuple(_subscribers):
        if not queue.full():
            queue.put_nowait(packet)


def _update(session_id: str, run: dict, **changes) -> None:
    run.update(changes)
    run["revision"] += 1
    _broadcast({"type": "update", "sessionId": session_id, "turnId": run["turnId"],
                "revision": run["revision"], "changes": changes})


def _finish(session_id: str, run: dict, status: str, error: str | None = None) -> None:
    if run["status"] != "processing":
        return
    _update(session_id, run, status=status, stopping=False, permission=None, error=error,
            waitingSince=None, providerDetail=None)
    run["endedAt"] = time.time()


def _responded(run: dict) -> None:
    # The model answered (text or a tool call): stop the wait clock. The packet
    # that carries the text or step tells viewers; nothing extra is sent.
    run["waitingSince"] = None
    run["providerDetail"] = None


def _ollama_target(session_id: str) -> tuple[str, str] | None:
    """(native root, model) when this chat's model is a loopback Ollama, else None."""
    try:
        from urllib.parse import urlparse
        from core import model_endpoints, ollama_client
        endpoint = chat_service._resolve_endpoint(session_id)
        if not endpoint or endpoint.get("kind") != "local":
            return None
        base_url, model, _key, _ctx = model_endpoints.resolve_runtime(endpoint["id"])
        if not ollama_client.is_ollama_url(base_url) or urlparse(base_url).hostname not in ("localhost", "127.0.0.1", "::1"):
            return None
        return ollama_client.native_root(base_url), model
    except Exception:
        return None


async def _ollama_detail(root: str, model: str) -> str | None:
    """Is the model in Ollama's /api/ps yet? None when the check fails."""
    from core import ollama_client
    try:
        running = await asyncio.wait_for(ollama_client.list_running(root), 3)
    except Exception:
        return None
    tag = lambda name: name if ":" in name else f"{name}:latest"
    loaded = {tag(str(item.get("model") or item.get("name") or "")) for item in running}
    return "Model is working" if tag(model) in loaded else "Loading the model into memory"


async def _check_waits(now: float | None = None) -> None:
    now = now or time.time()
    for session_id, run in list(_runs.items()):
        target, since = run.get("_ollama"), run.get("waitingSince")
        if (run["status"] != "processing" or not target or since is None or now - since < _WAIT_NOTICE_SECONDS
                or now - run.get("_checkedAt", 0) < _DETAIL_SECONDS):
            continue
        run["_checkedAt"] = now
        detail = await _ollama_detail(*target)
        if run["status"] == "processing" and run.get("waitingSince") is not None and detail != run.get("providerDetail"):
            _update(session_id, run, providerDetail=detail)


def _active() -> bool:
    return any(run["status"] == "processing" for run in _runs.values())


async def _keepalive() -> None:
    global _ticker
    try:
        while _active():
            await asyncio.sleep(_HEARTBEAT_SECONDS)
            if not _active():
                break
            for queue in tuple(_subscribers):  # not a chat turn: no phone projection, no snapshot reset
                if not queue.full():
                    queue.put_nowait({"type": "heartbeat"})
            await _check_waits()
    finally:
        if _ticker is asyncio.current_task():
            _ticker = None


def _ensure_ticker() -> None:
    global _ticker
    if _ticker is None or _ticker.done():
        _ticker = asyncio.create_task(_keepalive())


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
           "handoffs": None, "runId": None, "error": None, "revision": 1,
           "provider": (chat_service._resolve_endpoint(session_id) or {}).get("name") or "",
           "waitingSince": time.time(), "providerDetail": None, "_ollama": _ollama_target(session_id)}
    _runs[session_id] = run
    try:
        mobile_activity.create_run(run["turnId"], session, user, request_id, fingerprint)
        task = asyncio.create_task(_run(session_id, run, attachment_ids, is_admin, reference_context, references))
    except Exception:
        chat_service.release_session(session_id)
        _runs.pop(session_id, None)
        raise
    _tasks[session_id] = task
    _ensure_ticker()
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
    chat_service.LIVE_STEPS.set(True)  # this task's own context only
    try:
        stream = chat_service.stream_message(session_id, run["prompt"], attachment_ids, is_admin,
                                             reference_context, references, claimed=True)
        async with contextlib.aclosing(stream):
            async for item in stream:
                # Output after a request used to mean it was settled. A Codex
                # question stays open after its process writes and ends
                # (core/codex_questions.py), so ask the broker first.
                if run["permission"] and (isinstance(item, str) or
                                           isinstance(item, dict) and ("tool_step" in item or "handoffs" in item)) \
                        and permissions.pending_request(run["permission"].get("id", "")) is None:
                    _update(session_id, run, permission=None)
                context = runs.current_for(session_id)
                if context and run["runId"] != context.run_id:
                    _update(session_id, run, runId=context.run_id)
                if isinstance(item, str):
                    _responded(run)
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
                            _responded(run)
                            run["toolEvents"].append(value)
                            run["revision"] += 1
                            _broadcast({"type": "tool_event", "sessionId": session_id,
                                        "turnId": run["turnId"], "revision": run["revision"], "value": value})
                        elif key == "tool_step":
                            _responded(run)
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
    if _ticker:
        tasks.append(_ticker)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def broadcast_owner(packet: dict) -> None:
    """Owner-filtered by visible_packet; skips mobile notification projection."""
    for queue in tuple(_subscribers):
        if queue.full():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(snapshot())
        else:
            queue.put_nowait(deepcopy(packet))


def broadcast_followup(session_id: str, message: dict) -> None:
    broadcast_owner({'type': 'bg_followup', 'sessionId': session_id,
                     'message': {key: message.get(key) for key in ('role', 'content', 'ts', 'run_id', 'background_followup')}})
