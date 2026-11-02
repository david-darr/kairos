"""Front-desk tasks are records pointing at ordinary Bots conversations.

No second runner: admission, send receipts, slots, queueing and cancellation
belong to Phase 1. The small adapter below is the only internal-send seam.
"""
import hashlib
import importlib
import os
import re
import threading
import time
import uuid

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

DIRECTORY = os.path.join(DATA_DIR, "front_desk")
LOCK = threading.RLock()
TASK_FRAME = "Do the work in this task conversation. Do not start another task. Ask the person here when you need input."
MAKE_KINDS = ("design", "slides", "website", "files")


def read_rows(name):
    rows = read_json(os.path.join(DIRECTORY, name + ".json"), [])
    return rows if isinstance(rows, list) else []


def write_rows(name, rows, limit=2000):
    write_json_atomic(os.path.join(DIRECTORY, name + ".json"), rows[-limit:])


def front_context():
    """Identity comes from the seeded main session, never a tool argument."""
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    try:
        front_desk = importlib.import_module("services.front_desk")
    except ModuleNotFoundError as error:
        if error.name != "services.front_desk":
            raise
        state = read_json(os.path.join(DIRECTORY, "state.json"), {})
        bid, sid = state.get("bot_id"), state.get("main_thread_id")
    else:
        bid, sid = front_desk.bot_id(), front_desk.main_thread_id()
    bot = agent_service.get(bid) if bid else None
    session = session_manager.get_session(sid) if sid else None
    if not bot or bot.get("builtin") != "front_desk" or not session or session.get("agent_id") != bid:
        raise ValueError("Bring back the front desk before starting a task")
    from core.auth import SINGLE_USER, owner_or_default
    return bot, owner_or_default(session.get("owner_user")) or SINGLE_USER


def require_owner(user):
    if front_context()[1] != user:
        raise KeyError("front desk")


def title_from(text):
    title = re.split(r"(?<=[.!?])\s|\n", text.strip(), maxsplit=1)[0]
    if len(title) > 80:
        title = title[:81].rsplit(" ", 1)[0] or title[:80]
    return title[:80]


def list_tasks(user=None):
    from core.session_manager import session_manager
    bot, owner = front_context()
    if user is not None and owner != user:
        return []
    return [row for row in read_rows("tasks") if (s := session_manager.get_session(row["thread_id"]))
            and s.get("agent_id") == bot["id"] and (s.get("owner_user") or "local") == owner]


def get(task_id, user=None):
    task = next((t for t in list_tasks(user) if t["id"] == task_id), None)
    if task is None:
        raise KeyError(task_id)
    return task


def frame_for_thread(session_id):
    """Hook for P1's _context_note, including queued and subsequent turns."""
    return TASK_FRAME if any(t["thread_id"] == session_id for t in read_rows("tasks")) else ""


def send_internal(session_id, text, *, send_id, frame=TASK_FRAME):
    """Prefer P1's frozen internal door; adapt this branch's synchronous admission.

    The fallback uses the SAME receipt/claim/queue door. It never calls a model
    or chat_live.start directly. Integration should install send_internal and
    frame_for_thread in P1 so queued turns also receive the private frame.
    """
    from core import bot_message_tree
    from services import bot_chat_service
    internal = getattr(bot_chat_service, "send_internal", None)
    if internal is not None:
        return internal(session_id, text, send_id=send_id, frame=frame)
    from core.session_manager import session_manager
    session = session_manager.get_session(session_id)
    bot, owner = front_context()
    if not session or session.get("agent_id") != bot["id"] or (session.get("owner_user") or "local") != owner:
        raise KeyError(session_id)
    bot_chat_service.require(owner, session_id)
    session = bot_message_tree.ensure(session_id)
    payload = bot_chat_service._clean_payload({"text": text, "send_id": send_id,
                                             "expected_leaf_id": session["thread"]["active_leaf_id"]})
    bot_chat_service._check_send(session_id, payload)
    return bot_chat_service._admit(owner, session_id, bot, payload, frame)


def start(ask, *, origin, kind="task", make_kind=None, source=None, why=None, channel_tag=None, send_id):
    from core import bot_chat_store, session_manager_store
    from core.session_manager import session_manager
    from services import bot_threads
    from services.agent_service import agent_service
    if not isinstance(ask, str) or not 1 <= len(ask.strip()) <= 4000:
        raise ValueError("Write a task of up to 4000 characters")
    if not isinstance(send_id, str) or not 8 <= len(send_id) <= 80:
        raise ValueError("Use a send ID of 8 to 80 characters")
    if origin not in ("asked", "suggestion", "check_in", "make") or kind not in ("task", "make"):
        raise ValueError("Unknown task kind")
    if kind == "make" and make_kind not in MAKE_KINDS:
        raise ValueError("Choose Design, Slides, Web page or Files")
    if kind == "task" and make_kind is not None:
        raise ValueError("Choose Make to set a make kind")
    ask = ask.strip()
    with LOCK:
        bot, owner = front_context()
        rows = read_rows("tasks")
        previous = next((t for t in rows if t.get("send_id") == send_id), None)
        if previous:
            if (previous["ask"], previous.get("make_kind")) != (ask, make_kind):
                raise bot_chat_store.Conflict("This send ID was already used for another task")
            return get(previous["id"], owner)
        task_id = hashlib.sha256((bot["id"] + ":" + send_id).encode()).hexdigest()[:20]
        key = "front_desk: " + task_id
        sid = session_manager_store.get_channel_session(key)
        session = session_manager.get_session(sid) if sid else None
        if session is None:
            # These metadata writes and the channel key commit together. A retry
            # after a tasks.json write failure reuses the conversation.
            with session_manager_store.transaction():
                session = session_manager.create_session(title_from(ask), owner_user=owner)
                sid = session["id"]
                endpoint = agent_service.chat_endpoint(bot)
                if endpoint is None:
                    raise ValueError("Choose a model for the front desk first")
                session_manager.set_model_endpoint(sid, endpoint)
                agent_service.make_agent_chat(sid, bot, attended=False)
                session_manager.set_thread(sid, opened_by="task", main=False)
                session_manager_store.set_channel_session(key, sid)
        task = {"id": task_id, "title": title_from(ask), "ask": ask, "thread_id": sid, "origin": origin,
                "make_kind": make_kind, "source": source, "why": str(why or "")[:400],
                "channel_tag": str(channel_tag or "")[:80], "resolved_at": None,
                "created_at": time.time(), "send_id": send_id}
        if kind == "make" and make_kind != "files":
            from core import design_store
            design_store.set_design_mode(sid, True)
        rows.append(task)
        write_rows("tasks", rows)
        # Save BEFORE dispatch. A crash here is a lost internal turn, never
        # silently replayed. Its task remains visible and offers Try again.
        send_internal(sid, ask, send_id=send_id)
        return task.copy()


def derive_state(task):
    from services.front_desk_work import project
    return project(task)["state"]


def resolve(task_id, *, user=None, reopen=False):
    with LOCK:
        task = get(task_id, user)
        rows = read_rows("tasks")
        row = next(t for t in rows if t["id"] == task["id"])
        row["resolved_at"] = None if reopen else time.time()
        write_rows("tasks", rows)
    from services.front_desk_work import project
    return project(row)


def again(task_id, *, user=None, expected_turn_count):
    from services.front_desk_work import project, sources
    with LOCK:
        task = get(task_id, user)
        snapshot = sources(task)
        count = snapshot["turn_count"]
        # The caller captures the failed generation. Its second tap must not
        # retry a newer failure that happened to finish between requests.
        if expected_turn_count != count or project(task, snapshot=snapshot)["state"] != "failed":
            return project(task, snapshot=snapshot)
        send_internal(task["thread_id"], task["ask"], send_id=f"again:{task_id}:{count}")
        return project(task)
