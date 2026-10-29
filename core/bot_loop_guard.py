"""Harness-only repeat detection and opt-in correction of failing shell loops."""
import asyncio
import hashlib
import json
import secrets
from collections import OrderedDict

from core import runs
from core.logs import scrub_credentials

_THREADS = OrderedDict()
_NOTE_OPEN = f"[Kairos loop guard {secrets.token_hex(16)}]"
_SHELL = {"bash", "shell", "run_code", "exec_command", "commandexecution", "command_execution", "mcp__hive_mind__run_code"}
_TASKS = set()


def is_guard_note(text):
    return str(text).startswith(_NOTE_OPEN + "\n")


def _key(name, arguments):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            arguments = " ".join(arguments.split())
    return hashlib.sha256(json.dumps([name, arguments], sort_keys=True, default=str).encode()).hexdigest()


def observe(event, context=None, *, settings=None, waiting=None, emit=None, act=None):
    """Only RunEvents emitted by the harness can produce a steering note."""
    if not isinstance(event, runs.RunEvent) or context is None or not context.agent_id:
        return []
    from services import bot_peers
    settings = settings if settings is not None else bot_peers.state()["loop_guard"]
    sid = context.session_id or f"task:{context.task_id or context.run_id}"
    state = _THREADS.setdefault(sid, {"keys": OrderedDict(), "calls": {}, "last": None, "stopped": set()})
    _THREADS.move_to_end(sid)
    while len(_THREADS) > 512:
        _THREADS.popitem(last=False)
    keys, calls, out = state["keys"], state["calls"], []
    if event.kind == runs.EventKind.TOOL_STARTED:
        name, args = str(event.data.get("name", "")), event.data.get("input", "")
        key = _key(name, args)
        entry = keys.setdefault(key, {"count": 0, "steered": False})
        keys.move_to_end(key)
        while len(keys) > 256:
            keys.popitem(last=False)
        entry["count"] += 1
        calls[event.data.get("id")] = (name, key)
        if len(calls) > 256:
            calls.pop(next(iter(calls)))
        if entry["count"] in (5, 10, 20):
            out.append({"type": "repeat", "count": entry["count"], "tool": name,
                        "preview": scrub_credentials(str(args))[:160],
                        "content": f"Same call repeated {entry['count']} times, it may be stuck"})
    elif event.kind == runs.EventKind.TOOL_FINISHED:
        name, key = calls.pop(event.data.get("id"), ("", None))
        if key is None:
            return []
        failed = event.data.get("ok") is False and name.lower().split(".")[-1] in _SHELL
        failure = (key, scrub_credentials(str(event.data.get("output", "")))[:2000]) if failed else None
        previous = state["last"]
        count = previous[1] + 1 if failure and previous and previous[0] == failure and previous[2] == context.run_id else 1
        state["last"] = (failure, count, context.run_id) if failure else None
        parked = waiting(context) if waiting else _waiting(context)
        entry = keys.get(key)
        if settings["enabled"] and failed and not parked and entry:
            if settings.get("stop_at") is not None and count >= settings["stop_at"] and context.run_id not in state["stopped"]:
                state["stopped"].add(context.run_id)
                out.append({"action": "stop", "content": "Stopped after the same command kept failing."})
            elif count >= settings["steer_at"] and not entry["steered"] and context.run_id not in state["stopped"]:
                entry["steered"] = True
                out.append({"action": "steer", "content": _NOTE_OPEN + "\nThe same command failed repeatedly. Change approach, or explain what is blocking the work."})
        if len(state["stopped"]) > 256:
            state["stopped"] = {context.run_id}
    for row in out:
        if row.get("action"):
            (act or _act)(context, row)
        else:
            (emit or _emit)(context, row)
    return out


def _waiting(context):
    from core import permissions
    if permissions.waiting(f"chat:{context.session_id}") or permissions.waiting(f"agent:{context.agent_id}"):
        return True
    from services.agent_service import agent_service
    if agent_service.open_items_for_card(context.task_id):
        return True
    from services import chat_live
    current = chat_live.current_turn(context.session_id) if context.session_id else None
    return bool(current and current.get("permission"))


def _emit(context, row):
    if not context.session_id:
        return
    from core.session_manager import session_manager
    from services import chat_live
    message = session_manager.append_message(context.session_id, "assistant", row["content"], extra=row)
    if message:
        chat_live.broadcast_followup(context.session_id, message)


def _act(context, row):
    try:
        task = asyncio.get_running_loop().create_task(_apply(context, row))
    except RuntimeError:
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def _apply(context, row):
    from core.session_manager import session_manager
    from services import chat_live, agent_handoff, bot_chat_service
    if not context.session_id:
        if row["action"] == "stop" and context.task_id:
            from core import task_scheduler
            task_scheduler.stop_run(context.task_id)
        return
    sid = context.session_id
    live = chat_live.current_turn(sid)
    current = runs.current_for(sid)
    if not live or not current or current.run_id != context.run_id or _waiting(context):
        return
    session = session_manager.get_session(sid) or {}
    owner = session.get("owner_user")
    if row["action"] == "stop":
        if owner:
            bot_chat_service.interrupt(owner, sid, live["turn_id"])
        else:
            chat_live.stop_turn(sid, live["turn_id"], "person")
        _emit(context, {"type": "failed_turn", "content": row["content"], "cause": "loop"})
    else:
        chat_live.stop_turn(sid, live["turn_id"], "steer")
        if await chat_live.wait_settled(sid, live["turn_id"], 20):
            # A correction is unattended, and never acquires the person's authority.
            await agent_handoff._resume({"agent_id": context.agent_id, "session_id": sid}, row["content"])


runs.observe_tool_events(observe)
