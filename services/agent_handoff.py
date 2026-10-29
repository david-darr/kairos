"""Assignments on board cards; chat handoffs are the chat-requester form."""
import asyncio
import time
import uuid

from core import session_manager_store as store
from core.session_manager import session_manager
from core.untrusted import wrap_untrusted
from services.agent_service import agent_service
from services.task_service import STOPPED_NOTE, task_service

# 2026-10-14: five lets a coordinator fan out without unbounded model spend.
# A batch resumes at 30 minutes even if an off bot never starts.
MAX_ASSIGNMENTS_PER_RUN = 5
MAX_CHAIN_HOPS = 4
RESUME_CEILING_SECONDS = 30 * 60
_waking: set[str] = set()
_question_waking: set[str] = set()
_reconciled = False


def requester(card: dict) -> dict | None:
    return card.get("requester") or ({"kind": "chat", "session_id": card["reply_to"]}
                                     if card.get("reply_to") else None)


def person_inbox(agent_id: str | None = None) -> list[dict]:
    """A peer's first question belongs to its requester until escalated."""
    return [item for item in agent_service.inbox(agent_id)
            if item["kind"] != "question" or
            (requester(task_service.get_task(item.get("card_id")) or {}) or {}).get("kind") != "bot"
            or item.get("escalates_item_id")]


def _thread(card: dict) -> str | None:
    return (requester(card) or {}).get("session_id")


def _event(card: dict, agent: dict) -> dict:
    return {"type": "handoff", "id": uuid.uuid4().hex[:12], "agent_id": agent["id"],
            "agent_name": agent["name"], "agent_color": agent.get("color"), "agent_avatar": agent.get("avatar"), "card_id": card["id"],
            "handoff_status": "queued", "note": queue_note(agent["id"]),
            **{key: card.get(key) for key in ("mode", "reason", "done_when", "assignment_id", "partner", "work_session_id")}}


def _post_event(card: dict, agent: dict) -> dict:
    event = _event(card, agent)
    session_manager.append_message(_thread(card), "assistant", f"Handed to {agent['name']}", extra=event)
    return event


def recent_context(session_id: str) -> list[dict]:
    session = session_manager.get_session(session_id)
    if session is None:
        raise ValueError("The source chat no longer exists")
    return [m for m in session.get("messages", []) if m.get("role") in ("user", "assistant")
            and m.get("type") != "handoff"][-10:]


def hand_off(agent_id: str, work: str, source_session_id: str, context: list[dict]) -> dict:
    agent = agent_service.get(agent_id)
    if agent is None:
        raise ValueError("The agent no longer exists")
    if session_manager.get_session(source_session_id) is None:
        raise ValueError("The source chat no longer exists")
    if not isinstance(work, str) or not work.strip():
        raise ValueError("Say what work to hand over")
    lines = [f"{m.get('agent_name') or m.get('role')}: {str(m.get('content') or '')[:1200]}"
             for m in context[-10:] if m.get("role") in ("user", "assistant") and m.get("type") != "handoff"]
    framed = wrap_untrusted("recent context from another conversation", "\n\n".join(lines)[:12000])
    card = task_service.create_task(work.strip().splitlines()[0][:60], work.strip(), "card",
                                    status="ready", agent_id=agent_id, reply_to=source_session_id, context=framed,
                                    requester={"kind": "chat", "session_id": source_session_id})
    return _post_event(card, agent)


def assign(requesting_id: str, target: str, work: str, session_id: str | None = None,
           run_id: str | None = None, source_card_id: str | None = None, *, mode="work", reply="resume",
           thread="new", title="", reason="", done_when="", rework=False, room_id=None,
           approved=False) -> str:
    """A model-facing refusal is text, so bad delegation cannot end its turn."""
    from core import runs
    from core import bot_assignments as assignments
    from services import bot_peers
    source = agent_service.get(requesting_id)
    if source is None:
        return "Assignment refused: the requesting bot no longer exists."
    try:
        peer = bot_peers.resolve(target)
        bot_peers.authorize(source, peer, approved=approved, session_id=session_id)
    except (ValueError, PermissionError, KeyError) as error:
        return f"Assignment refused: {error}"
    if not isinstance(work, str) or not work.strip():
        return "Assignment refused: say what work to assign."
    current = agent_service._current.get() or {}
    source_card_id = source_card_id or current.get("card_id")
    origin = task_service.get_task(source_card_id) if source_card_id else None
    if origin is None and session_id:
        origin = next((c for c in task_service.list_tasks()
                       if c.get("coordination_thread_id") == session_id and c.get("agent_id") == requesting_id), None)
        if origin:
            source_card_id = origin["id"]
    chain = list((origin or {}).get("assignment_chain") or [requesting_id])
    if len(chain) >= MAX_CHAIN_HOPS + 1:
        return f"Assignment refused: a delegation chain may have at most {MAX_CHAIN_HOPS} hops."
    if peer["id"] in chain:
        return "Assignment refused: this would create a bot delegation cycle."
    context = runs.current_for(session_id)
    turn_id = run_id or (context.run_id if context else source_card_id or session_id)
    if not turn_id:
        return "Assignment refused: start this from a bot run or chat."
    existing = [c for c in task_service.list_tasks() if (c.get("requester") or {}).get("run_id") == turn_id
                and (c.get("requester") or {}).get("agent_id") == requesting_id]
    if len(existing) >= MAX_ASSIGNMENTS_PER_RUN:
        return f"Assignment refused: at most {MAX_ASSIGNMENTS_PER_RUN} assignments per turn."
    if not session_id:
        # One durable bot thread belongs to the originating card. Its results
        # remain readable even when the original background run has ended.
        if not origin:
            return "Assignment refused: no requesting thread was found."
        session_id = origin.get("coordination_thread_id")
        if not session_id:
            session_id = session_manager.create_session(f"Work on {origin['name']}")["id"]
            endpoint_id = agent_service.chat_endpoint(source)
            if endpoint_id:
                session_manager.set_model_endpoint(session_id, endpoint_id)
            agent_service.make_agent_chat(session_id, source, attended=False)
            origin["coordination_thread_id"] = session_id
            task_service._save_tasks()
    if (session_manager.get_session(session_id) or {}).get("agent_id") != requesting_id:
        return "Assignment refused: the requesting thread does not belong to this bot."
    # The work is output from another model, perhaps copied from the web.
    # Keep it inside an untrusted fence in the assignee's actual prompt.
    framed = bot_peers.provenance(source, work.strip(), kind="Delegated by")
    request = {"kind": "bot", "agent_id": requesting_id, "session_id": session_id,
               "run_id": turn_id, "source_card_id": source_card_id,
               "created_at": time.time()}
    if room_id:
        # The room runner, not a model argument, must supply room authority.
        from services import bot_rooms
        if not bot_rooms.can_speak(requesting_id, room_id):
            return "Assignment refused: the requesting bot cannot speak in this room."
        request.update(kind="room", room_id=room_id)
    try:
        admission_request = {key: value for key, value in request.items() if key != "created_at"}
        node = assignments.admit(admission_request, peer["id"], work.strip(),
            parent_id=(origin or {}).get("assignment_id"), mode=mode, reply=reply,
            destination="standing_thread" if thread == "standing" or mode == "notify" else "work_thread",
            origin="room" if room_id else "routine" if origin else "person", title=title,
            reason=reason, done_when=done_when, rework=rework, approved=approved,
            room_lane=bool(room_id and any(n["requester"].get("room_id") == room_id and
                           n["status"] not in assignments.TERMINAL for n in assignments.tree())))
    except (ValueError, PermissionError) as error:
        return f"Assignment refused: {error}"
    if node.get("card_id"):
        return f"Assigned to {peer['name']} (card {node['card_id']}). End this turn and do not poll."
    request["assignment_id"] = node["id"]
    if mode == "notify":
        work_session = _work_thread(peer, source, session_id, standing=True)
        session_manager.append_message(work_session, "assistant", framed, extra={
            "type": "handoff", "assignment_id": node["id"], "mode": "notify", "handoff_status": "done",
            "partner": {"id": source["id"], "name": source["name"]}})
        session_manager.set_untrusted_context(work_session, "message from another bot")
        assignments.update(node["id"], work_session_id=work_session)
        assignments.settle(node["id"], result="Notification delivered.")
        session_manager.append_message(session_id, "assistant", f"Notified {peer['name']}", extra={
            "type": "handoff", "assignment_id": node["id"], "mode": mode, "handoff_status": "done",
            "partner": {"id": peer["id"], "name": peer["name"]}, "work_session_id": work_session})
        return f"Notified {peer['name']}. End this turn and do not poll."
    work_session = _work_thread(peer, source, session_id, standing=thread == "standing", title=title)
    card = task_service.create_task(work.strip().splitlines()[0][:60], framed, "card", status="ready",
                                    agent_id=peer["id"], requester=request)
    card["assignment_chain"] = chain + [peer["id"]]
    card.update(assignment_id=node["id"], mode=mode, reason=reason, done_when=done_when,
                work_session_id=work_session, partner={"id": peer["id"], "name": peer["name"]})
    assignments.update(node["id"], card_id=card["id"], work_session_id=work_session)
    session_manager.append_message(work_session, "assistant", framed, extra={
        "type": "handoff", "assignment_id": node["id"], "card_id": card["id"], "mode": mode,
        "handoff_status": "queued", "partner": {"id": source["id"], "name": source["name"]}})
    session_manager.set_untrusted_context(work_session, "delegated work from another bot")
    task_service._save_tasks()
    event = _post_event(card, peer)
    return f"Assigned to {peer['name']} (card {card['id']}, assignment {node['id']})." + (f" {event['note']}" if event["note"] else "") + " End this turn and do not poll."


def _work_thread(peer, source, source_session, *, standing=False, title=""):
    from services import bot_threads
    if standing:
        main = next((s for s in session_manager.list_sessions(agent_id=peer["id"]) if s.get("agent_id") == peer["id"]
                     and (s.get("thread") or {}).get("main")), None)
        if main:
            return main["id"]
    owner = (session_manager.get_session(source_session) or {}).get("owner_user")
    session = session_manager.create_session(title or f"@{source['name']} work", owner_user=owner)
    agent_service.make_agent_chat(session["id"], peer, attended=False)
    endpoint = agent_service.chat_endpoint(peer)
    if endpoint:
        session_manager.set_model_endpoint(session["id"], endpoint)
    session_manager.set_thread(session["id"], opened_by="handoff")
    return session["id"]


def queue_note(agent_id: str) -> str:
    may_run, reason = agent_service.can_run(agent_id)
    agent = agent_service.get(agent_id)
    if not may_run and agent and agent.get("enabled") and "today" in reason:
        return f"{agent['name']} is at today's limit"
    return reason if not may_run else ""


def _update(session_id: str, predicate, fields: dict) -> None:
    session = session_manager.get_session(session_id)
    for index, message in enumerate((session or {}).get("messages", [])):
        if predicate(message):
            store.update_message_fields(session_id, index, fields)


def sync_card(card: dict) -> None:
    _sync_assignment(card)
    session_id = _thread(card)
    if not session_id:
        return
    status = {"ready": "queued", "backlog": "queued", "running": "working", "review": "done",
              "done": "done", "blocked": "failed"}[card["status"]]
    if status != "failed" and agent_service.open_items_for_card(card["id"]):
        status = "needs_you"
    _update(session_id, lambda m: m.get("type") == "handoff" and m.get("card_id") == card["id"],
            {"handoff_status": status, "note": queue_note(card["agent_id"]) if status == "queued" else ""})
    if card.get("work_session_id"):
        _update(card["work_session_id"], lambda m: m.get("type") == "handoff" and m.get("card_id") == card["id"],
                {"handoff_status": status})
    if (requester(card) or {}).get("kind") == "bot" and status in ("done", "failed"):
        schedule_wake()


def _post(card: dict, text: str, key: str, **extra) -> None:
    session_id = _thread(card)
    session = session_manager.get_session(session_id) if session_id else None
    if session is None or any(m.get("handoff_message_id") == key for m in session.get("messages", [])):
        return
    agent = agent_service.get(card["agent_id"]) or {"name": "Agent"}
    session_manager.append_message(session_id, "assistant", text, extra={
        "agent_id": card["agent_id"], "agent_name": agent["name"], "agent_color": agent.get("color"), "agent_avatar": agent.get("avatar"),
        "card_id": card["id"], "handoff_message_id": key, **extra})
    session_manager.set_untrusted_context(session_id, "agent reply from another conversation")


def finished(card: dict, output: str) -> None:
    if requester(card):
        from services import bot_peers
        reply = (bot_peers.provenance(card["agent_id"], output)
                 if requester(card)["kind"] in ("bot", "room") else output)
        if card.get("mode") != "notify" and (requester(card)["kind"] != "room"):
            _post(card, reply, f"handoff:{card['id']}:{card.get('run_id') or card.get('attempts')}")
        if card.get("work_session_id"):
            sid = card["work_session_id"]
            key = f"assignment-result:{card['id']}:{card.get('attempts')}"
            if not any(m.get("handoff_message_id") == key for m in (session_manager.get_session(sid) or {}).get("messages", [])):
                session_manager.append_message(sid, "assistant", output, extra={"handoff_message_id": key,
                                               "agent_id": card["agent_id"], "assignment_id": card.get("assignment_id")})
        sync_card(card)


def mirror_question(item: dict) -> None:
    card = task_service.get_task(item.get("card_id")) if item.get("card_id") else None
    if card and requester(card) and item["kind"] == "question":
        body = item["title"] + ("\n\n" + item["body"] if item.get("body") else "")
        if requester(card)["kind"] == "bot":
            body = wrap_untrusted("question from another bot", body)
        _post(card, body,
              f"handoff:question:{item['id']}", inbox_item_id=item["id"], question_status=item["status"])
        sync_card(card)
        if requester(card)["kind"] == "bot":
            schedule_question(item)


def question_resolved(item: dict) -> None:
    card = task_service.get_task(item.get("card_id")) if item.get("card_id") else None
    if card and requester(card):
        _update(_thread(card), lambda m: m.get("inbox_item_id") == item["id"],
                {"question_status": item["status"]})
        sync_card(card)


def close_batch(agent_id: str, *, session_id: str | None = None, source_card_id: str | None = None) -> None:
    """Called when the asking turn exits; later cards cannot join its batch."""
    now = time.time()
    changed = False
    for card in task_service.list_tasks():
        req = card.get("requester") or {}
        if (req.get("kind") == "bot" and req.get("agent_id") == agent_id
                and not card.get("batch_closed_at") and
                (req.get("source_card_id") == source_card_id if source_card_id else
                 req.get("session_id") == session_id)):
            card["batch_closed_at"] = now
            changed = True
    if changed:
        task_service._save_tasks()
        schedule_wake()


def _groups() -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for card in task_service.list_tasks():
        req = card.get("requester") or {}
        if req.get("kind") == "bot" and req.get("run_id"):
            groups.setdefault(req["run_id"], []).append(card)
    return groups


def _settled(card: dict) -> bool:
    return card.get("status") in ("review", "done", "blocked")


async def wake_batches(now: float | None = None) -> None:
    """Poll from the scheduler, so settled batches and deadlines survive restart."""
    now = time.time() if now is None else now
    _assignment_tick(now)
    for batch_id, cards in _groups().items():
        deadline = min(c["requester"]["created_at"] for c in cards) + RESUME_CEILING_SECONDS
        # 2026-10-14: an asking run cut off by process loss has no finally
        # to close its batch. The same ceiling closes it during recovery.
        if not all(c.get("batch_closed_at") for c in cards) and now >= deadline:
            for card in cards:
                card["batch_closed_at"] = now
            task_service._save_tasks()
        if (batch_id in _waking or any(c.get("batch_resumed_at") for c in cards)
                or not all(c.get("batch_closed_at") for c in cards)
                or not (all(_settled(c) for c in cards) or now >= deadline)):
            continue
        req = cards[0]["requester"]
        if not agent_service.can_run(req["agent_id"])[0]:
            continue
        _waking.add(batch_id)
        try:
            lines = []
            for card in sorted(cards, key=lambda c: c["created_at"]):
                result = next((c["text"] for c in reversed(card.get("comments") or [])
                               if c["kind"] in ("result", "error")), "")
                label = "succeeded" if card["status"] in ("review", "done") else (
                    ("stopped" if result == STOPPED_NOTE else "failed")
                    if card["status"] == "blocked" else "still outstanding")
                lines.append(f"{card['name']} ({card['id']}): {label}. " +
                             (wrap_untrusted("peer result", result) if result else ""))
            from core import bot_assignments
            roots = {n["root_id"] for c in cards if c.get("assignment_id")
                     if (n := bot_assignments.get(c["assignment_id"]))}
            if any(not bot_assignments.consume_wake(root) for root in roots):
                for root in roots:
                    bot_assignments.cancel(root, "budget", whole_tree=True)
                continue
            await _resume(req, "Your delegated assignments have settled or reached the 30 minute ceiling:\n" +
                          "\n".join(lines) + "\nContinue the work with these results.")
            for card in cards:
                card["batch_resumed_at"] = time.time()
            task_service._save_tasks()
        except Exception:
            # A retry on the next scheduler pass preserves a failed wake.
            import logging
            logging.getLogger(__name__).exception("could not resume bot assignment batch %s", batch_id)
        finally:
            _waking.discard(batch_id)


async def _resume(req: dict, prompt: str) -> None:
    from services import chat_service
    # Coordinated continuation is unattended and uses the same admission
    # reservation as background cards (2026-10-14). No recall extras.
    with agent_service.run(req["agent_id"]):
        session_id = req["session_id"]
        async with chat_service.session_operation(session_id):
            await _resume_claimed(req, prompt)


async def _resume_claimed(req: dict, prompt: str) -> None:
    from services import chat_service
    from services.agent_service import identity_block
    session_id = req["session_id"]
    session = session_manager.get_session(session_id) or {}
    agent = agent_service.get(req["agent_id"])
    if not agent or session.get("agent_id") != agent["id"]:
        raise ValueError("The requesting bot's thread is unavailable")
    origin = task_service.get_task(req.get("source_card_id")) if req.get("source_card_id") else None
    if origin:
        prompt = (f"Continue your original work, {origin['name']}. Its saved objective is context:\n" +
                  wrap_untrusted("original card text", origin["prompt"]) + "\n\n" + prompt)
    if not session.get("model_endpoint_id"):
        await _resume_default_model(req, prompt, agent)
        return
    old_prompt = session.get("agent_prompt")
    core_prompt = identity_block(agent, agent_service.read_memory(agent["id"]))
    changed = old_prompt != core_prompt
    if changed:
        await chat_service.close_session_brain(session_id)
        session_manager.set_agent(session_id, agent["id"], core_prompt)
        session_manager.set_claude_session(session_id, None)
        session_manager.set_codex_thread_id(session_id, None)
    try:
        await chat_service.send_message(session_id, prompt, is_admin=False, claimed=True)
    finally:
        if changed:
            await chat_service.close_session_brain(session_id)
            session_manager.set_agent(session_id, agent["id"], old_prompt)
            session_manager.set_claude_session(session_id, None)
            session_manager.set_codex_thread_id(session_id, None)


async def _resume_default_model(req: dict, prompt: str, agent: dict) -> None:
    """A background bot can use default Claude without a configured chat model."""
    from core.task_scheduler import _task_brain, complete
    source_id = req.get("source_card_id")
    brain = _task_brain({"id": source_id, "agent_id": agent["id"]})
    session_id = req["session_id"]
    session_manager.append_message(session_id, "user", prompt)
    current = {"agent_id": agent["id"], "card_id": source_id, "task_id": None,
               "raised": [], "active": True}
    token = agent_service._current.set(current)
    try:
        await brain.connect()
        if hasattr(brain, "pending_reference_taint"):
            brain.pending_reference_taint = "result from another bot"
        # Its vault edits are this chat's turn, checkpointed like any other
        # (as core/task_scheduler.py does), not "Edited outside Kairos".
        from core import file_checkpoints
        async with file_checkpoints.around_turn(f"chat:{session_id}"):
            output = await complete(brain, agent_service.run_prompt(agent, prompt),
                                    {"id": source_id, "agent_id": agent["id"]}, "agent")
        session_manager.append_message(session_id, "assistant", output,
                                       extra={"agent_id": agent["id"], "agent_name": agent["name"]})
    finally:
        current["active"] = False
        agent_service._current.reset(token)
        close_batch(agent["id"], session_id=session_id)
        await brain.disconnect()


def schedule_wake() -> None:
    try:
        asyncio.get_running_loop().create_task(wake_batches())
    except RuntimeError:
        pass  # the scheduler's next pass also scans durable cards


def schedule_question(item: dict) -> None:
    try:
        asyncio.get_running_loop().create_task(wake_questions())
    except RuntimeError:
        pass  # the durable inbox is scanned on the next scheduler pass


async def wake_questions() -> None:
    for item in agent_service.inbox(status=None):
        if item["kind"] != "question" or item["status"] != "open" or item.get("bot_delivered_at"):
            continue
        card = task_service.get_task(item.get("card_id")) if item.get("card_id") else None
        req = requester(card) if card else None
        if not req or req.get("kind") != "bot" or item["id"] in _question_waking:
            continue
        if not agent_service.can_run(req["agent_id"])[0]:
            continue
        _question_waking.add(item["id"])
        try:
            # The inbox save precedes the mirror; recover that narrow crash
            # window before waking the bot (2026-10-14).
            mirror_question(item)
            await _resume(req, f"{(agent_service.get(card['agent_id']) or {}).get('name', 'A peer')} asks for a decision "
                          f"(question {item['id']}). Answer it with agent_answer_assignment, or escalate "
                          "it to the person.\n" + wrap_untrusted("question from another bot",
                          item["title"] + "\n" + (item.get("body") or "")))
            item["bot_delivered_at"] = time.time()
            agent_service._save_inbox()
        except Exception:
            import logging
            logging.getLogger(__name__).exception("could not deliver bot question %s", item["id"])
        finally:
            _question_waking.discard(item["id"])


def answer_question(requesting_id: str, item_id: str, answer: str = "", escalate: bool = False) -> str:
    item = agent_service.get_item(item_id)
    card = task_service.get_task(item.get("card_id")) if item else None
    req = requester(card) if card else None
    if not req or req.get("kind") != "bot" or req.get("agent_id") != requesting_id:
        return "Question not found among your assignments."
    if item["status"] != "open":
        return "That question has already been answered."
    if escalate:
        if item.get("escalated_item_id"):
            return f"Question {item_id} is already escalated (inbox {item['escalated_item_id']})."
        upstream = agent_service.add_item(requesting_id, "question", item["title"], item.get("body") or "")
        upstream["escalates_item_id"] = item_id
        item["escalated_item_id"] = upstream["id"]
        agent_service._save_inbox()
        agent_service.notify(upstream)
        return f"Escalated question {item_id} to the person (inbox {upstream['id']})."
    if not answer.strip():
        return "Write an answer, or choose to escalate."
    return agent_service.answer_item(item_id, "reply", wrap_untrusted("answer from another bot", answer.strip()))


def _sync_assignment(card):
    from core import bot_assignments as assignments
    aid = card.get("assignment_id")
    if not aid or not (node := assignments.get(aid)) or node["status"] in assignments.TERMINAL:
        return
    items = agent_service.open_items_for_card(card["id"])
    if items:
        assignments.update(aid, status="needs_input", question=items[0]["title"])
    elif card["status"] in ("review", "done", "blocked"):
        result = next((c["text"] for c in reversed(card.get("comments") or []) if c["kind"] in ("result", "error")), "")
        assignments.settle(aid, "done" if card["status"] in ("review", "done") else
                           "stopped" if result == STOPPED_NOTE else "provider_error", result,
                           evidence=assignments.evidence(card.get("run_id")))
    else:
        assignments.update(aid, status="running" if card["status"] == "running" else "queued",
                           run_id=card.get("run_id"))


def _assignment_changed(node):
    """Keep cancelled/expired nodes out of the card dispatch queue."""
    if node["status"] not in ("failed", "cancelled") or not node.get("card_id"):
        return
    card = task_service.get_task(node["card_id"])
    if not card or card["status"] in ("review", "done", "blocked"):
        return
    from core import task_scheduler
    task_scheduler.stop_run(card["id"])
    card.update(status="blocked", claimed_until=None)
    task_service._save_tasks()
    sid = _thread(card)
    if sid:
        _update(sid, lambda m: m.get("card_id") == card["id"] and m.get("type") == "handoff",
                {"handoff_status": "failed", "note": node["outcome"]})


def _assignment_tick(now):
    global _reconciled
    from core import bot_assignments as assignments
    if not _reconciled:
        assignments.reconcile_startup(now=now, read_evidence=lambda n: assignments.evidence(
            (task_service.get_task(n.get("card_id")) or {}).get("run_id")))
        for node in assignments.tree():
            card = task_service.get_task(node.get("card_id"))
            if card and node.get("restart_marker") == "rerun" and card["status"] == "running":
                card.update(status="ready", claimed_until=None)
                card["prompt"] = "Restart note: the previous run was interrupted before any outward action.\n" + card["prompt"]
                task_service._save_tasks()
        _reconciled = True
    assignments.tick(now=now, parked=lambda n: bool(agent_service.open_items_for_card(n.get("card_id"))))


def _deleted_bot(bot_id):
    from core import bot_assignments as assignments
    for node in assignments.tree(bot_id=bot_id):
        if node["status"] not in assignments.TERMINAL:
            assignments.cancel(node["id"], "refused", whole_tree=True)


from core import bot_assignments as _assignments
_assignments.on_change(_assignment_changed)
agent_service.on_delete(_deleted_bot)
