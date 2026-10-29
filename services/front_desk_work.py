"""Read model for Tasks. State is computed from authoritative thread sources."""
import importlib
import re
import time
from urllib.parse import urlsplit

from services import front_desk_tasks as tasks

GROUPS = ("ready_for_review", "needs_input", "failed", "working", "resolved")
FAILURES = {"request_error": "Check the model and task settings", "rate_limited": "The model is busy. Try again shortly",
            "model_error": "The model could not finish", "lost": "The reply was interrupted"}


def optional_service(name):
    try:
        return importlib.import_module("services." + name)
    except ModuleNotFoundError as error:
        if error.name != "services." + name:
            raise
        return None


def _thread_cards(thread_id):
    """P3 seam: the card store's rows for one conversation, read as that conversation's owner.

    Missing P3 is an empty projection. A present module with a mismatched
    interface fails loudly, so integration cannot hide a gap.
    """
    cards = optional_service("bot_cards")
    if not cards:
        return []
    from core.session_manager import session_manager
    owner = (session_manager.get_session(thread_id) or {}).get("owner_user")
    return cards.store().list_cards(owner, thread_id=thread_id)


def pending_cards(thread_id):
    from services.bot_cards import OPEN_STATUSES
    return [c for c in _thread_cards(thread_id) if c.get("status") in OPEN_STATUSES]


def decisions(thread_id):
    from services.bot_cards import OPEN_STATUSES
    return [c for c in _thread_cards(thread_id) if c.get("status") not in OPEN_STATUSES]


def questions(bot_id):
    from services.agent_service import agent_service
    from services.task_service import task_service
    result = []
    for item in agent_service.inbox(bot_id):
        if item.get("kind") != "question" or item.get("answer"):
            continue
        card = task_service.get_task(item.get("card_id")) or {}
        requester = card.get("requester") or {}
        sid = item.get("session_id") or item.get("thread_id") or requester.get("session_id") or card.get("reply_to")
        result.append({**item, "thread_id": sid})
    return result


def sources(task):
    from core import bot_chat_store, bot_message_tree, permissions, session_manager_store
    from core.session_manager import session_manager
    from services import chat_live
    sid = task["thread_id"]
    session = session_manager.get_session(sid) or {}
    owner = session.get("owner_user") or "local"
    path = bot_message_tree.ancestry(session)
    queue = bot_chat_store.queue(owner, sid)
    runs = session_manager_store.list_runs(sid, limit=200)
    turn = chat_live.current_turn(sid)
    # Count all physical user rows, including alternative branches, so a
    # retry key can never refer to a different generation after branching.
    count = sum(m.get("role") == "user" for m in session.get("messages") or [])
    count += len(queue["items"])
    return {"session": session, "messages": path, "processing": chat_live.is_processing(sid),
            "queue": queue["items"], "dispatching": sid in bot_chat_store.sessions_dispatching(),
            "cards": pending_cards(sid), "approvals": permissions.pending_for("chat:" + sid),
            "questions": [q for q in questions(session.get("agent_id")) if q.get("thread_id") == sid],
            "turn": turn, "runs": runs, "turn_count": count}


def words(message):
    return " ".join(str(message.get("content") or "").split())


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", str(text or "")) if s.strip()]


def next_step(text):
    parts = sentences(text)
    return parts[-1][:240] if parts else "Just started"


def project(task, *, snapshot=None, now=None):
    now = time.time() if now is None else now
    s = sources(task) if snapshot is None else snapshot
    messages = s.get("messages", [])
    text_rows = [m for m in messages if m.get("role") in ("assistant", "user") and
                 (words(m) or m.get("failure_kind") or m.get("status"))
                 and not m.get("display_only") and m.get("type") != "fd_card"]
    latest = text_rows[-1] if text_rows else {}
    assistant = next((m for m in reversed(text_rows) if m.get("role") == "assistant"), {})
    stamp = max([task.get("created_at", 0), *[m.get("ts", 0) or 0 for m in text_rows]])
    turns = s.get("runs") or []
    turn = s.get("turn") or {}
    last_run = turns[0] if turns else {}
    # A stale live record or old failed run must not override a newer reply.
    terminal_at = max(turn.get("started_at", 0), last_run.get("started_at", 0))
    newest_user = max((m.get("ts", 0) or 0 for m in text_rows if m.get("role") == "user"), default=0)
    outcome = turn.get("status") if turn.get("started_at", 0) >= last_run.get("started_at", 0) else last_run.get("outcome")
    failed_row = latest.get("role") == "assistant" and bool(latest.get("failure_kind"))
    failed = failed_row or (outcome == "failed" and terminal_at >= newest_user
                            and terminal_at >= (assistant.get("ts", 0) or 0))
    stopped = outcome in ("stopped", "needs_input", "waiting")
    pending = bool(s.get("cards") or s.get("approvals") or s.get("questions"))
    asks = latest.get("role") == "assistant" and words(latest).rstrip('"\'`*)] ').endswith("?") and not failed_row
    active_queue = any(q.get("state", "pending") == "pending" for q in s.get("queue", []))
    interrupted = any(q.get("state") == "interrupted" for q in s.get("queue", []))
    grace = now - stamp < 60 and not assistant and not outcome
    dispatching = s.get("dispatching") and now - max(stamp, terminal_at) < 60 and not outcome
    resolved = task.get("resolved_at") and (assistant.get("ts", 0) or 0) <= task["resolved_at"]
    lost = (not assistant or latest.get("role") == "user") and now - stamp >= 60 and not stopped
    if pending or asks:
        state = "needs_input"
    elif s.get("processing") or active_queue or dispatching or grace:
        state = "working"
    elif resolved:
        state = "resolved"
    elif not stopped and (failed or interrupted or lost):
        state = "failed"
    else:
        state = "ready_for_review"
    failure = latest.get("failure_kind") if failed_row else "lost" if lost or interrupted else "model_error"
    step = next_step(words(assistant))
    if state == "failed":
        step = "Could not finish: " + FAILURES.get(failure, FAILURES["model_error"])
    elif pending:
        question = (s.get("questions") or [{}])[0]
        step = question.get("body") or question.get("title") or "Open the conversation to answer"
    return {**task, "state": state, "next_step": step[:240], "updated_at": stamp,
            "turn_count": s.get("turn_count", 0)}


def work(*, user=None, resolved=False):
    from core import permissions
    from core.session_manager import session_manager
    from services import front_desk_suggestions
    bot, owner = tasks.front_context()
    if user is not None:
        tasks.require_owner(user)
    groups = {name: [] for name in GROUPS}
    rows = tasks.list_tasks(user)
    now = time.time()
    for task in rows:
        row = project(task, now=now)
        if row["state"] == "resolved" and (not resolved or now - row["resolved_at"] > 7 * 86400):
            continue
        groups[row["state"]].append(row)
    for group in groups.values():
        group.sort(key=lambda t: (t["updated_at"], t["id"]), reverse=True)
    task_threads = {t["thread_id"] for t in rows}
    headers = [h for h in session_manager.list_sessions(agent_id=bot["id"])
               if (h.get("owner_user") or "local") == owner and h["id"] not in task_threads]
    loose = {"questions": [], "approvals": []}
    loose_threads = {h["id"] for h in headers}
    loose["questions"] = [q for q in questions(bot["id"]) if q.get("thread_id") in loose_threads or not q.get("thread_id")]
    for header in headers:
        sid = header["id"]
        loose["approvals"].extend({**c, "thread_id": sid} for c in pending_cards(sid))
        known = {c.get("request_id") or c.get("id") for c in loose["approvals"]}
        loose["approvals"].extend({**c, "thread_id": sid} for c in permissions.pending_for("chat:" + sid)
                                 if c.get("id") not in known)
    upcoming = []
    from services.task_service import task_service
    for routine in task_service.list_tasks():
        if routine.get("agent_id") == bot["id"] and routine.get("enabled") and routine.get("kind") != "card" \
                and (routine.get("owner_user") or owner) == owner:
            upcoming.append({k: routine.get(k) for k in ("id", "title", "name", "next_run_at", "revision")})
    return {"groups": groups, "loose": loose, "up_next": front_desk_suggestions.list_suggestions(user),
            "coming_up": upcoming, "updated_at": now,
            "needs_input_count": len(groups["needs_input"]) + sum(len(v) for v in loose.values())}


def needs_input_count():
    return work()["needs_input_count"]


def safe_link(value):
    try:
        url = urlsplit(str(value or ""))
        return str(value) if url.scheme == "https" and url.hostname and not url.username and not url.password else None
    except ValueError:
        return None


def report(task_id, *, user=None):
    task = tasks.get(task_id, user)
    snapshot = sources(task)
    updates, resources, seen = [], [], set()
    # One update per turn: retain the last assistant words before the next
    # user row, then use their first sentence. The original ask is not a reply.
    assistant = None
    def flush():
        if assistant and words(assistant):
            updates.append({"kind": "update", "text": sentences(words(assistant))[0][:400], "at": assistant.get("ts")})
    initial = True
    for message in snapshot["messages"]:
        role = message.get("role")
        if message.get("display_only") or message.get("type") == "fd_card":
            continue
        if role == "user":
            flush()
            assistant = None
            if not initial:
                updates.append({"kind": "reply", "text": words(message)[:400], "at": message.get("ts")})
            initial = False
        elif role == "assistant":
            assistant = message
        # Only explicit read provenance, never guessing a resource from an
        # arbitrary tool argument, URL in prose, or an email search result.
        for resource in message.get("resources") or []:
            if not isinstance(resource, dict) or resource.get("kind") not in ("mail", "calendar", "file", "web"):
                continue
            identity = (resource["kind"], str(resource.get("id") or resource.get("ref") or ""))
            if not identity[1] or identity in seen:
                continue
            seen.add(identity)
            resources.append({"kind": resource["kind"], "id": identity[1],
                              "title": str(resource.get("title") or "Resource")[:200],
                              "url": safe_link(resource.get("url")), "at": message.get("ts")})
    flush()
    for card in decisions(task["thread_id"]):
        updates.append({"kind": "decision", "text": str(card.get("title") or "Decision")[:400],
                        "status": card.get("status"), "at": card.get("decided_at") or card.get("created_at")})
    return {"task": project(task, snapshot=snapshot), "updates": sorted(updates, key=lambda u: u.get("at") or 0)[-200:],
            "resources": resources[-200:]}
