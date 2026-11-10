"""Bots inbox, retained notifications and redacted runtime observations.

The inbox is rebuilt from authoritative sources on every read. Read/Done are
personal display preferences; answering always rechecks the source and invokes
the existing question, review or permission broker.
"""
import copy
import json
import threading
import time

from fastapi import HTTPException

from core import bot_attention_store as store
from core.auth import SINGLE_USER, auth_manager
from core.logs import scrub_credentials

_RESPOND_LOCK = threading.RLock()
NOTIFICATION_KINDS = {"approval", "question", "done", "routine-failed", "routine-deferred", "turn-failed",
                      "incident", "sign-in", "delegation-settled", "mention", "spend", "brief", "missed-call",
                      "message"}


def clean(value, limit=2000):
    return scrub_credentials(str(value or ""))[:limit]


def legacy_owner():
    """Who owns bot work that names no owner: the current account's user (Multi-Account group 4: every
    account has its own bots), else the old install-wide default (accounts off, or nobody signed in)."""
    from core import accounts
    from core.auth import auth_enabled, auth_manager, owner_or_default
    if not auth_enabled():
        return owner_or_default(None)  # every request is the single local user
    try:
        name = auth_manager.username_for_account(accounts.effective_account())
    except accounts.NoAccount:
        name = None
    return name or owner_or_default(None)


def owner_of(record):
    return next((record.get(k) for k in ("owner_user", "owner", "user_id", "created_by") if record.get(k)), None)


def owns(record, user):
    return (owner_of(record) or legacy_owner()) == user


def require_bot(ident, user):
    from services.agent_service import agent_service
    agent = agent_service.get(ident)
    # The historical bot registry is shared. Owned records, when present,
    # never inherit the old admin exception. Sessions/sources are always scoped.
    if not agent or (owner_of(agent) and owner_of(agent) != user):
        raise HTTPException(404, "Bot not found")
    return agent


def require_thread(ident, user):
    from core.session_manager import session_manager
    session = session_manager.get_session(ident)
    if not session or not session.get("agent_id") or not owns(session, user):
        raise HTTPException(404, "Conversation not found")
    require_bot(session["agent_id"], user)
    return session


def _session_doc(sid):
    """A conversation's document without its transcript. Every caller here needs its id, owner, bot, thread and
    dates, never the messages: loading each transcript made the inbox and notifications cost the sum of every
    bot conversation's length (240 to 460 ms with a month of routines, 100-bot scale test, 2026-11-10)."""
    from core import session_manager_store
    found = session_manager_store.get_session_header(sid)
    return found[0] if found else None


def _sessions(user, agent_id=None):
    from core.session_manager import session_manager
    result = []
    for header in session_manager.list_sessions(agent_id=agent_id, include_agents=True):
        if not header.get("agent_id"):
            continue
        session = _session_doc(header["id"])
        if session and owns(session, user):
            result.append(session)
    return result


def _by_agent(sessions):
    """The person's bot conversations by bot, in list order: read once a request, not once a row."""
    grouped = {}
    for session in sessions:
        grouped.setdefault(session["agent_id"], []).append(session)
    return grouped


def _source_visible(source, user, agent=None, docs=None):
    """A linked foreign task/session wins over a legacy ownerless record. An
    ownerless source inherits its bot's owner when the bot has one. docs: conversations already read this
    request, by id (filled as it goes)."""
    from services.task_service import task_service
    docs = {} if docs is None else docs
    scopes = [source] if owner_of(source) else []
    if agent and owner_of(agent):
        scopes.append(agent)
    for key in ("card_id", "task_id"):
        if source.get(key):
            task = task_service.get_task(source[key])
            if task:
                scopes.append(task)
    for key in ("session_id", "origin_session_id", "reply_to"):
        if source.get(key):
            if source[key] not in docs:
                docs[source[key]] = _session_doc(source[key])
            session = docs[source[key]]
            if session:
                scopes.append(session)
    explicit = [r for r in scopes if owner_of(r)]
    return all(owns(r, user) for r in explicit) if explicit else owns(source, user)


def target_for(agent_id, user, source=None, sessions=None):
    """sessions: the person's conversations by bot (_by_agent), when the caller already read them."""
    source = source or {}
    direct = source.get("session_id") or source.get("origin_session_id") or source.get("reply_to")
    # A room member asks in its seat session, which only the room shows: open the room (services/bot_rooms.py).
    seat = direct or source.get("thread_id")
    if seat:
        try:
            from core import bot_rooms_store
            found = bot_rooms_store.room_for_seat(seat)
        except Exception:
            found = None
        if found:
            return {"tab": "botsRoom", "roomId": found[0]}
    sessions = sessions.get(agent_id, []) if sessions is not None else _sessions(user, agent_id)
    chosen = next((s for s in sessions if s["id"] == direct), None)
    if not chosen:
        chosen = next((s for s in sessions if (s.get("thread") or {}).get("main")), None)
    if not chosen and sessions:
        chosen = min(sessions, key=lambda s: (s.get("created_at", 0), s["id"]))
    result = {"tab": "botsShell", "agentId": agent_id}
    if chosen:
        result["sessionId"] = chosen["id"]
        mid = source.get("bot_message_id") or source.get("message_id")
        if mid and (not direct or direct == chosen["id"]):
            result["messageId"] = mid
    return result


def _row(user, source_id, kind, source, agent, *, actions, open=True, sessions=None):
    subject = clean(source.get("title") or source.get("name") or "Waiting for you", 200)
    body = source.get("body") or source.get("description") or ""
    if kind == "review":
        body = next((c.get("text") for c in reversed(source.get("comments") or []) if c.get("kind") == "result"), body)
    revision = store.stable_id(source_id, source.get("status"), source.get("answer"), subject, body,
                               source.get("expires_at"), actions, source.get("questions"))
    return {"id": source_id, "source_id": source_id, "kind": kind, "sender": {"id": agent["id"], "name": clean(agent.get("name"), 100)},
            "subject": subject, "snippet": clean(" ".join(str(body).split()), 240), "body": clean(body, 16000),
            "at": source.get("created_at") or source.get("updated_at") or 0, "status": "open" if open else "resolved",
            "target": target_for(agent["id"], user, source, sessions), "actions": actions if open else [], "revision": revision,
            "answer": clean(source.get("answer"), 4000) or None, "questions": source.get("questions") or []}


def inbox(user):
    from core import permissions
    from services.agent_service import agent_service
    from services.agent_handoff import person_inbox
    from services.task_service import task_service
    preferences = store.inbox_preferences(user)
    rows = []
    visible_open = {i["id"] for i in person_inbox()}
    cutoff = time.time() - 30 * 86400
    mine = _sessions(user)
    by_agent = _by_agent(mine)
    docs = {session["id"]: session for session in mine}
    for item in agent_service.inbox(status=None):
        agent = agent_service.get(item.get("agent_id"))
        if not agent or (owner_of(agent) and not owns(agent, user)) or not _source_visible(item, user, agent, docs):
            continue
        is_open = item.get("status") == "open"
        if is_open and item["id"] not in visible_open:
            continue  # a peer's question is still addressed to its requester
        if (item.get("created_at") or 0) < cutoff and not (is_open and item.get("kind") == "question"):
            continue
        actions = ["reply", "close"] if item.get("kind") == "question" else ["reply", "open"]
        rows.append(_row(user, "item:" + item["id"], item["kind"], item, agent, actions=actions, open=is_open,
                         sessions=by_agent))
    for card in task_service.list_tasks():
        agent = agent_service.get(card.get("agent_id"))
        if not agent or (owner_of(agent) and not owns(agent, user)) or card.get("schedule_kind") != "card" or not _source_visible(card, user, agent, docs):
            continue
        if card.get("status") not in ("review", "done") or (card.get("updated_at") or card.get("created_at") or 0) < cutoff:
            continue
        rows.append(_row(user, "review:" + card["id"], "review", card, agent,
                         actions=["approve", "reply", "open"], open=card.get("status") == "review", sessions=by_agent))
    for session in mine:
        agent = agent_service.get(session["agent_id"])
        if not agent or (owner_of(agent) and not owns(agent, user)):
            continue
        for request in permissions.pending_for("chat:" + session["id"]):
            source = {**request, "session_id": session["id"], "body": request.get("description"),
                      "created_at": request.get("expires_at", time.time()) - (
                          permissions.QUESTION_TIMEOUT_SECONDS if request.get("kind") == "question"
                          else permissions.DEFAULT_TIMEOUT_SECONDS)}
            kind = "question" if request.get("kind") == "question" else "approval"
            row = _row(user, "permission:" + request["id"], kind, source, agent,
                       actions=["respond", "skip"] if kind == "question" else ["allow", "deny"], sessions=by_agent)
            row["questions"] = json.loads(clean(json.dumps(request.get("questions") or []), 32000))
            rows.append(row)
    for row in rows:
        pref = preferences.get(row["id"], {})
        row.update(read=pref.get("read", False), done=pref.get("done", False))
        row["bucket"] = "done" if row["done"] or row["status"] != "open" else "news" if row["kind"] == "report" else "needs-you"
    rows.sort(key=lambda r: (r["at"], r["id"]), reverse=True)
    # Never let a news backlog hide live requests. The sources still own older
    # unresolved questions; retain them ahead of ordinary historical rows.
    live = [r for r in rows if r["status"] == "open" and r["kind"] != "report"]
    live_ids = {id(r) for r in live}
    ordinary = [r for r in rows if id(r) not in live_ids]  # by identity: comparing whole rows was O(rows x live)
    rows = (live + ordinary)[:2000]
    counts = {key: sum(r["bucket"] == key for r in rows) for key in ("needs-you", "news", "done")}
    return {"rows": rows, "counts": counts, "count": counts["needs-you"]}


def inbox_row(user, ident):
    row = next((r for r in inbox(user)["rows"] if r["id"] == ident), None)
    if not row:
        raise HTTPException(404, "Inbox item not found")
    return row


def respond(user, ident, *, action, text="", expected_revision, answers=None, request=None):
    from core import permissions
    from services.agent_service import agent_service
    from services import chat_live
    with _RESPOND_LOCK:
        row = inbox_row(user, ident)
        if row["revision"] != expected_revision or row["status"] != "open" or action not in row["actions"] or action == "open":
            raise HTTPException(409, "That request is no longer available. Reload and try again.")
        lane, source_id = ident.split(":", 1)
        try:
            if lane == "permission":
                pending = permissions.pending_request(source_id)
                if not pending or not pending.surface.startswith("chat:"):
                    raise ValueError("That request is no longer available.")
                require_thread(pending.surface.removeprefix("chat:"), user)
                if pending.tool == "creative_tools" and pending.arguments.get("account_owner") != user:
                    raise HTTPException(404, "Inbox item not found")
                if row["kind"] == "question":
                    error = permissions.respond(source_id, answers=answers, skip=action == "skip", user=user)
                    if error:
                        raise ValueError(error)
                elif not permissions.answer(source_id, "once" if action == "allow" else "reject", user):
                    raise ValueError("That request is no longer available.")
                chat_live.permission_answered(source_id)
                result = "answered"
            elif lane == "review":
                if action == "reply" and not text.strip():
                    raise ValueError("Write a reply first.")
                result = agent_service.review(source_id, "approve" if action == "approve" else text)
            else:
                # Snapshot the one authoritative item. A synchronous delivery
                # failure must reopen it; async team delivery already does so.
                item = agent_service.get_item(source_id)
                before = copy.deepcopy(item)
                try:
                    result = agent_service.answer_item(source_id, "dismiss" if action == "close" else "reply", text)
                except Exception:
                    item.clear()
                    item.update(before)
                    agent_service._save_inbox()
                    raise
        except (ValueError, KeyError) as error:
            raise HTTPException(409, clean(error, 300)) from error
        store.set_inbox(user, ident, read=True)
        # Do not set Done: an async failed answer reopening its source must
        # automatically return to Needs you on the next projection.
        return {"ok": True, "result": clean(result, 300)}


def rebuild(user):
    """Repair feed projections from sources, without delivering old alerts. One database transaction for all of
    them (it was a connection a row, on every notifications read)."""
    items = []
    for row in inbox(user)["rows"]:
        if row["status"] != "open":
            continue
        kind = "approval" if row["kind"] == "review" else "done" if row["kind"] == "report" else row["kind"]
        source = row["source_id"]
        items.append((source, {"kind": kind, "agent_id": row["sender"]["id"], "title": row["subject"],
                               "body": row["snippet"], "target": row["target"], "at": row["at"],
                               "inbox_id": source, "backlog": True}))
    store.publish_many(user, items)


def notifications(user):
    rebuild(user)
    rows = store.notifications(user)
    # Deleted/foreign bots and reassigned sessions never leak retained text. The same checks as require_bot and
    # require_thread, each conversation read once (without its transcript), not once a row.
    allowed, threads = [], {}
    for row in rows:
        try:
            require_bot(row.get("agent_id"), user)
        except HTTPException:
            continue
        sid = (row.get("target") or {}).get("sessionId")
        if sid:
            if sid not in threads:
                threads[sid] = _thread_visible(sid, user)
            if not threads[sid]:
                continue
        allowed.append(row)
    return {"rows": allowed, "unread": sum(not r["read"] for r in allowed)}


def _thread_visible(sid, user):
    """require_thread's answer, from the conversation's document alone."""
    session = _session_doc(sid)
    if not session or not session.get("agent_id") or not owns(session, user):
        return False
    try:
        require_bot(session["agent_id"], user)
    except HTTPException:
        return False
    return True


def mark_thread_read(owner, sid, message_id):
    """The runtime's read cursor moved (bot_chat_service.mark_read): mark this
    conversation's notifications read up to that message."""
    store.read_thread(owner, sid, message_id, None)


def ingest_event(event):
    """One trusted event-bus subscriber, called from bot_push.start().

    U1 emits bot.runtime with agent_id/session_id and a data runtime envelope,
    plus bot.turn.completed/failed terminal events with a stable turn_id.
    Owner is resolved from the session/task, never event payload owner fields.
    Returns newly receipted notifications for device delivery.
    """
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    from services.task_service import task_service
    kind = event.get("type", "")
    agent_id = event.get("agent_id") or event.get("bot_id")
    agent = agent_service.get(agent_id)
    if not agent:
        return []
    sid = event.get("session_id")
    source = session_manager.get_session(sid) if sid else None
    if sid and (not source or source.get("agent_id") != agent_id):
        return []
    item = agent_service.get_item(event.get("item_id")) if event.get("item_id") else None
    task = task_service.get_task(event.get("task_id")) if event.get("task_id") else None
    authority = source or task or item or agent
    if item:
        for key in ("card_id", "task_id"):
            if item.get(key):
                authority = task_service.get_task(item[key]) or authority
    owner = owner_of(authority) or legacy_owner()
    if not owner or not auth_manager.is_admin(owner) or (owner_of(agent) and not owns(agent, owner)) or not _source_visible(authority, owner, agent):
        return []
    event_id = event.get("event_id") or store.stable_id(kind, event.get("turn_id"), event.get("run_id"),
                                                      event.get("item_id"), event.get("task_id"), event.get("ts"), event.get("data"))
    runtime = event.get("data") if isinstance(event.get("data"), dict) else {}
    # Observation payload is a strict allowlist, not arbitrary provider input
    # or a raw event dump. Secrets are scrubbed before writing and on reads.
    at = float(event.get("ts") or time.time())
    observation = {"id": event_id, "kind": "runtime", "at": at, "source": "kairos-runtime",
                   "data": {key: clean(runtime.get(key, event.get(key)), 1000) for key in
                            ("type", "status", "label", "detail", "outcome", "turn_id", "run_id", "message_id")
                            if runtime.get(key, event.get(key)) is not None}}
    if kind.startswith("bot.") or kind.startswith("agent."):
        store.observe(owner, event_id, agent_id, sid, at, observation)
    notification_kind = None
    inbox_id = None
    if kind == "agent.inbox" and item and item.get("status") == "open":
        # Respect peer-question routing.
        from services.agent_handoff import person_inbox
        if item["id"] not in {i["id"] for i in person_inbox()}:
            return []
        notification_kind = "question" if item.get("kind") == "question" else "done"
        inbox_id = "item:" + item["id"]
    elif kind == "agent.review" and task and task.get("status") == "review":
        notification_kind, inbox_id = "approval", "review:" + task["id"]
    elif kind in ("bot.turn.completed", "bot.completed", "bot.turn_done"):
        notification_kind = "done"
    elif kind in ("bot.turn.failed", "bot.failed", "bot.turn_failed"):
        notification_kind = "turn-failed"
    elif kind == "bot.help" and event.get("help_id"):
        # A bot asks the person to sign in or take over its computer (services/bot_help.py, Phase 6).
        notification_kind, inbox_id = "sign-in", "help:" + str(event["help_id"])
    elif kind == "bot.runtime":
        terminal = runtime.get("type") or runtime.get("kind")
        notification_kind = {"turn.completed": "done", "turn.failed": "turn-failed", "runtime.error": "turn-failed"}.get(terminal)
    if not notification_kind:
        return []
    if inbox_id:
        receipt = inbox_id
    else:
        # Runtime and terminal producers may both describe one turn. They use
        # one receipt regardless of the bus frame ID.
        turn = event.get("turn_id") or runtime.get("turn_id") or event.get("run_id")
        if not turn:
            return []
        receipt = f"turn:{sid}:{turn}:{notification_kind}"
    title = clean((item or task or {}).get("title") or (task or {}).get("name") or event.get("message") or
                  ("Reply ready" if notification_kind == "done" else "Reply could not finish"), 200)
    row = store.publish(owner, receipt, {"kind": notification_kind, "agent_id": agent_id, "title": title,
                                        "body": clean((item or {}).get("body") or title, 240),
                                        "target": target_for(agent_id, owner, {**(source or item or task or {}),
                                                            "session_id": sid or (item or {}).get("session_id"),
                                                            "message_id": event.get("message_id") or runtime.get("message_id")}),
                                        "inbox_id": inbox_id, "at": at, "backlog": False})
    if row and agent.get("notifications") is not False:
        return [{**row, "owner": owner}]
    return []


def _scrubbed(entry):
    """Stored text is scrubbed on the way in; scrub again on the way out."""
    data = {k: clean(v, 1000) if isinstance(v, str) else v for k, v in (entry.get("data") or {}).items()}
    return {**entry, "data": data}


def thread_events(user, sid, limit=400):
    require_thread(sid, user)
    from core import session_manager_store as sessions
    projected = store.observations(user, session=sid, limit=limit)
    entries = [_scrubbed(e) for e in projected["entries"]]
    # Existing persisted run timelines are actual Kairos adapter observations,
    # clearly labelled. They are never claimed to be native provider traces.
    runs = sessions.find_runs(session_id=sid, limit=100)
    count = projected["total"]
    for run in runs:
        timeline = sessions.run_events(run["id"])
        count += len(timeline)
        entries.extend({"id": f"run:{run['id']}:{n}", "kind": "runtime", "at": e["at"],
                        "source": "kairos-run-timeline", "data": {k: clean(v, 1000) if isinstance(v, str) else v
                        for k, v in e.items() if k in ("kind", "name", "ok", "detail", "seconds")}, "run_id": run["id"]}
                       for n, e in enumerate(timeline))
    entries.sort(key=lambda e: (e["at"], e["id"]), reverse=True)
    return {"entries": entries[:limit], "total": count, "runs": [{k: r.get(k) for k in
            ("id", "started_at", "ended_at", "outcome", "model", "input_tokens", "output_tokens")} for r in runs]}


def activity(user, agent_id, limit=300):
    require_bot(agent_id, user)
    rows = []
    for session in _sessions(user, agent_id):
        rows.extend({**e, "target": {"tab": "botsShell", "agentId": agent_id, "sessionId": session["id"]}}
                    for e in thread_events(user, session["id"], limit)["entries"])
    # Include persisted source observations without a conversation (reports).
    seen = {r["id"] for r in rows}
    rows.extend(_scrubbed(e) for e in store.observations(user, bot=agent_id)["entries"] if e["id"] not in seen)
    rows.sort(key=lambda e: (e["at"], e["id"]), reverse=True)
    return {"entries": rows[:limit], "total": len(rows)}


def today(user, since=None):
    from core import session_manager_store as sessions
    since = since if since is not None else time.time() - 86400
    rows = []
    for session in _sessions(user):
        try:
            require_bot(session["agent_id"], user)
        except HTTPException:
            continue
        for run in sessions.find_runs(session_id=session["id"], limit=300):
            if (run.get("started_at") or 0) < since:
                continue
            rows.append({"id": run["id"], "agent_id": session["agent_id"], "title": clean(session.get("title"), 200),
                         "at": run.get("started_at"), "outcome": run.get("outcome"), "target": target_for(session["agent_id"], user,
                         {"session_id": session["id"]})})
    rows.sort(key=lambda r: (r["at"], r["id"]), reverse=True)
    return {"since": since, "finished": rows[:300], "counts": {outcome: sum(r["outcome"] == outcome for r in rows)
            for outcome in sorted({r["outcome"] for r in rows if r["outcome"]})}, "needs_you": needs_you(user)["rows"]}


def needs_you(user):
    # The inbox's own needs-you bucket: open, not a report, and not marked done by this person.
    return {"rows": [r for r in inbox(user)["rows"] if r["bucket"] == "needs-you"]}
