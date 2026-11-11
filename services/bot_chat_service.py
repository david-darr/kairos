"""Bots conversation admission and runtime (Bots Phase 1, unit U1).

The one door for a person's message to a bot: it checks ownership and the
bot's slot, records the send durably, and either starts a turn or queues the
message. A bot's conversation is a tree of messages (core/bot_message_tree.py);
edits and regenerated answers add branches and never delete.

Rules this module keeps:
- A send is accepted once. The receipt, the saved message and the queue row
  commit together (core/bot_chat_store.py); a retry gets the first answer.
- Slots are counted in running threads, one admission lock decides, and an
  overflow becomes a queue row, never a lost message.
- Queues drain on the server after a turn has released its claim, whether or
  not any window is open.
- Stop names the turn it means. A late Stop never reaches the next turn.
"""
import asyncio
import json
import logging
import threading
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from core import bot_chat_store as store, bot_message_tree as tree, events, session_manager_store as sstore
from core.session_manager import session_manager
from services import chat_live, chat_service

logger = logging.getLogger(__name__)

REACTIONS = ("thumbs_up", "thumbs_down", "heart", "laugh", "tada", "eyes")
COALESCE_SECONDS = 120
MAX_COALESCE = 30
NOT_COALESCED = ("spoken", "relayed", "unattended", "goal", "goal-step")
MODES = (None, "goal", "spoken")
PAGE_DEFAULT, PAGE_MAX = 50, 200
EXPORT_MAX = 2000
SEARCH_PENDING_MAX = 8
STEER_STOP_SECONDS = 20.0
PRESENCE_MIN_SECONDS = 55
REASON_TEXT = {
    "busy": "This conversation is busy. Wait for the reply, or stop it first.",
    "capacity": "This bot is already working in as many conversations as it is allowed. Try again shortly.",
    "queued-ahead": "Messages are already waiting in this conversation. Send or clear them first.",
}

_ADMISSION = threading.RLock()  # one decision at a time: who runs, who waits
_HOLDS: set[str] = set()  # threads a steer is in the middle of
_DRAIN_LOCKS: dict[str, asyncio.Lock] = {}
_TASKS: set = set()
_PRESENCE: dict[str, dict] = {}
_SEARCH_SLOTS = threading.Semaphore(2)
_search_pending = 0


# -- access ----------------------------------------------------------------------

def require(owner: str, sid: str) -> tuple[dict, dict]:
    """(session, bot) for a conversation the caller owns, or a 404. A session
    that is not a bot's thread is not found here."""
    from services.agent_service import agent_service
    session = chat_live.require_session(sid, owner)
    agent = agent_service.get(session.get("agent_id")) if session.get("agent_id") else None
    if agent is None:
        raise HTTPException(404, "conversation not found")
    return session, agent


def _tasks_add(task) -> None:
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def _bot_of(sid: str):
    header = sstore.get_session_header(sid)
    return header[0].get("agent_id") if header else None


def running_threads(bot_id: str, exclude: str | None = None) -> set[str]:
    """Threads of one bot using a slot right now: a turn running, or the thread
    claimed for another operation (a routine run, a compaction)."""
    busy = set(chat_live.running_threads(bot_id)) | {s for s in tuple(chat_service._busy) if _bot_of(s) == bot_id}
    busy.discard(exclude)
    return busy


def _reason(sid: str, bot: dict, *, claimed: bool = False) -> str | None:
    """Why a new message cannot start now: busy, queued-ahead, capacity; None when it can."""
    if sid in _HOLDS or chat_live.is_processing(sid) or (not claimed and chat_service.is_busy(sid)):
        return "busy"
    if store.waiting_count(sid):
        return "queued-ahead"
    if len(running_threads(bot["id"], sid)) >= int(bot.get("thread_limit") or 3):
        return "capacity"
    return None


# -- payloads --------------------------------------------------------------------

def _clean_payload(body: dict) -> dict:
    text = body.get("text")
    if not isinstance(text, str):
        raise ValueError("Write a message")
    attachment_ids = list(dict.fromkeys(body.get("attachment_ids") or []))
    if not text.strip() and not attachment_ids:
        raise ValueError("Write a message or attach a file")
    if body.get("mode") not in MODES:
        raise ValueError("Unknown message mode")
    payload = {"send_id": body["send_id"], "text": text, "expected_leaf_id": body.get("expected_leaf_id"),
               "attachment_ids": attachment_ids, "reply_to_id": body.get("reply_to_id"),
               "citations": list(body.get("citations") or []), "references": list(body.get("references") or []),
               "mode": body.get("mode")}
    # Phase 6 extras ride along only when present, so a plain send keeps its exact shape and retry fingerprint.
    if isinstance(body.get("data_context"), dict) and body["data_context"]:
        payload["data_context"] = body["data_context"]
    if body.get("pointed"):
        payload["pointed"] = list(body["pointed"])[:5]
    return payload


def _shown(payload: dict) -> dict:
    """What identifies a send for retry matching. The leaf the person saw is left out:
    a lost-response retry is the same message however far the thread has moved."""
    return {key: value for key, value in payload.items() if key != "expected_leaf_id"}


def _row_by_id(sid: str, message_id: str) -> dict | None:
    with sstore.transaction() as conn:
        row = conn.execute("SELECT doc FROM messages WHERE session_id=? AND json_extract(doc,'$.bot_message_id')=?",
                           (sid, message_id)).fetchone()
    return json.loads(row["doc"]) if row else None


def _context_note(sid: str, payload: dict) -> str:
    """Private lines sent with the model's copy of a message: what it replies
    to and what the person quoted, fenced and labelled as outside text."""
    from core.untrusted import wrap_untrusted
    note = ""
    if payload.get("reply_to_id"):
        target = _row_by_id(sid, payload["reply_to_id"])
        if target and target.get("content"):
            note += "\n\n[The person is replying to this earlier message:]\n" + wrap_untrusted(
                "an earlier message in this conversation", str(target["content"])[:2000])
    for citation in payload.get("citations") or []:
        quote = str(citation.get("quote") or "")[:12000]
        if quote:
            note += "\n\n[The person quoted this passage" + (
                f" and said: {str(citation.get('comment'))[:4000]}" if citation.get("comment") else "") + ":]\n" + \
                wrap_untrusted("a passage the person selected", quote)
    return note


def _check_send(sid: str, payload: dict) -> None:
    chat_service.validate_image_attachments(sid, payload["attachment_ids"])
    if payload["reply_to_id"] and _row_by_id(sid, payload["reply_to_id"]) is None:
        raise ValueError("The message you are replying to is gone")
    if len(payload["references"]) > 5:
        raise ValueError("Select at most 5 references")


async def _context(owner: str, sid: str, references: list) -> str:
    from core import chat_references
    if not references:
        return await asyncio.to_thread(chat_references.resolve, sid, [], True, owner)
    return await asyncio.to_thread(chat_references.resolve, sid, references, True, owner)


# -- sending ---------------------------------------------------------------------

async def send(owner: str, sid: str, body: dict) -> dict:
    """Accept a message from the person: start a turn, or queue it with a reason."""
    session, bot = require(owner, sid)
    payload = _clean_payload(body)
    _check_send(sid, payload)
    # The monthly spend cap (Bots Phase 6) stops a new turn at this door too, not only background work.
    from services import bot_spend
    try:
        bot_spend.check(bot["id"])
    except bot_spend.SpendCap as cap:
        raise HTTPException(409, cap.detail, headers={"X-Reason": cap.code}) from None
    context = await _context(owner, sid, payload["references"])
    context += _phase6_context(bot["id"], sid, payload)
    # A typed reply answers an open computer help request from this conversation (Phase 6 U1, "answer in chat").
    from services import bot_help
    try:
        bot_help.answer_in_chat(bot["id"], sid)
    except (KeyError, ValueError):
        pass  # already settled or replaced: the message still goes
    return _admit(owner, sid, bot, payload, context)


def _phase6_context(bot_id: str, sid: str, payload: dict) -> str:
    """What the person was looking at, for the model's copy of this message only (Phase 6): the data result they
    have open, the parts of an app they pointed at, and a state an app in this conversation reported. All of it is
    fenced as untrusted data by the helpers that build it; none of it is saved into the transcript text."""
    from services import bot_apps, bot_data
    parts = [bot_data.data_context(bot_id, payload.get("data_context")),
             bot_apps.pointed_note(payload.get("pointed")), bot_apps.pending_context_note(sid)]
    return "".join("\n\n" + part.strip() for part in parts if part)


def _admit(owner: str, sid: str, bot: dict, payload: dict, context: str, *, direct_only: bool = False,
           claimed: bool = False, parent=store._UNSET, existing_message_id: str | None = None,
           expected_revision: int | None = None, shown: dict | None = None) -> dict:
    with _ADMISSION:
        shown = shown or _shown(payload)
        earlier = store.receipt(owner, sid, payload["send_id"], shown)
        if earlier is not None:
            if claimed:
                chat_service.release_session(sid)
            return {**earlier, "replayed": True}
        reason = _reason(sid, bot, claimed=claimed)
        if reason and direct_only:
            if claimed:
                chat_service.release_session(sid)
            raise HTTPException(409, REASON_TEXT[reason], headers={"X-Reason": reason})
        if not reason and not claimed:
            try:
                chat_service.claim_session(sid)
                claimed = True
            except HTTPException:
                reason = "busy"
        generation = uuid.uuid4().hex
        try:
            result = store.accept(owner, sid, payload, reason, generation, parent_id=parent,
                                  existing_message_id=existing_message_id, expected_revision=expected_revision,
                                  fingerprint_payload=shown)
        except BaseException:
            if claimed:
                chat_service.release_session(sid)
            raise
        if reason:
            if claimed:
                chat_service.release_session(sid)
            _announce(sid, owner, "queued", result["queue_id"])
            return result
        try:
            _launch(owner, sid, bot, payload, result["message_index"], generation, context)
        except BaseException:
            chat_service.release_session(sid)
            store.fail_dispatch(sid, generation)
            raise
        return result


def _launch(owner: str, sid: str, bot: dict, payload: dict, index: int, generation: str, context: str) -> None:
    """Start the turn for a message that is saved and recorded. The session claim is held."""
    from core import chat_references
    from services import bot_goal_runs
    note = _context_note(sid, payload)
    chunk_filter = None
    if payload.get("mode") in ("goal", "goal-step"):
        note += bot_goal_runs.NOTE
        chunk_filter = bot_goal_runs.EnvelopeFilter()
    references = chat_references.metadata(payload.get("references") or [])
    chat_live.start(sid, payload["text"], payload.get("attachment_ids") or [], True, context, references,
                    user=owner, turn_id=generation, accepted_index=index, claimed=True,
                    turn_note=note, chunk_filter=chunk_filter)
    _runtime(sid, owner, bot["id"], "started", generation)
    if payload.get("mode") == "goal":
        from core import session_manager_store
        row = session_manager_store.get_message(sid, index) or {}
        bot_goal_runs.begin(owner, sid, bot["id"], payload, generation, row.get("bot_message_id"))


# -- events and frames -----------------------------------------------------------

def _runtime(sid: str, owner: str, bot_id: str, phase: str, turn_id: str | None = None, **extra) -> None:
    """The domain event other units subscribe to (core/events.py): `bot.runtime`
    for lifecycle moves of a turn or queue, never carrying message text."""
    events.emit("bot.runtime", f"Bot turn {phase}", agent_id=bot_id, session_id=sid, owner=owner,
                phase=phase, turn_id=turn_id, **extra)


def _announce(sid: str, owner: str, why: str, queue_id: str | None = None) -> None:
    """Owner-filtered queue frame on the existing live feed."""
    try:
        queue = store.queue(owner, sid)
        chat_live.broadcast_owner({"type": "bot_queue", "sessionId": sid, "why": why, "queueId": queue_id,
                                   "revision": queue["revision"], "paused": queue["paused"],
                                   "items": [_queue_item(item) for item in queue["items"]],
                                   "consumedQueueIds": queue["consumed_queue_ids"]})
    except Exception:
        logger.exception("could not broadcast the queue of %s", sid)


def _queue_item(item: dict) -> dict:
    payload = item["payload"]
    return {"id": item["id"], "state": item["state"], "send_id": item["send_id"], "text": payload["text"],
            "attachment_ids": payload.get("attachment_ids") or [], "reply_to_id": payload.get("reply_to_id"),
            "citations": payload.get("citations") or [], "mode": payload.get("mode"),
            "created_at": item["created_at"], "resumes_message": bool(item.get("message_id"))}


# -- turn end, queue drain -------------------------------------------------------

def turn_ended(sid: str, run: dict) -> None:
    """Called once a turn has finished and its claim is free. Writes the turn's
    terminal facts, then lets the bot's queue move. Touches only this turn's
    own generation: a newer turn of the session is never modified here."""
    generation, status = run["turnId"], run["status"]
    bot_id, owner = run.get("_agent_id"), run.get("_owner")
    newer = chat_live.current_turn(sid)
    stale = bool(newer and newer["turn_id"] != generation)
    person_stop = status == "stopped" and run.get("_stop_reason", "person") == "person"
    pause = not stale and (person_stop or status == "failed")
    if person_stop and not stale:
        try:
            session_manager.append_message(sid, "assistant", "You stopped this.",
                                           extra={"display_only": True, "kind": "stopped", "turn_id": generation})
        except KeyError:
            return
    try:
        store.terminal(sid, generation, pause=pause)
    except KeyError:
        return
    kind = {"done": "bot.turn_done", "failed": "bot.turn_failed", "stopped": "bot.turn_stopped"}.get(status)
    if kind:
        events.emit(kind, f"Bot turn {status}", level="warn" if status == "failed" else "info",
                    agent_id=bot_id, session_id=sid, owner=owner, turn_id=generation, run_id=run.get("runId"))
    _runtime(sid, owner, bot_id, "ended", generation, status=status, reason=run.get("_stop_reason"))
    try:
        from services import bot_goal_runs
        bot_goal_runs.turn_ended(sid, run)
    except Exception:
        logger.exception("goal bookkeeping failed for %s", sid)
    _announce(sid, owner, "turn-ended")
    schedule_drain(bot_id)


def schedule_drain(bot_id: str | None) -> None:
    if not bot_id:
        return
    try:
        _tasks_add(asyncio.get_running_loop().create_task(drain(bot_id)))
    except RuntimeError:
        pass  # no event loop (a test calling turn_ended directly): the next drain picks it up


def _eligible_group(bot_id: str) -> list[dict] | None:
    """The next queued rows to start for this bot, oldest first across its
    threads, skipping threads that are busy, paused, held or already running."""
    from services.agent_service import agent_service
    bot = agent_service.get(bot_id)
    if bot is None:
        return None
    running = running_threads(bot_id)
    if len(running) >= int(bot.get("thread_limit") or 3):
        return None
    rows = store.pending(bot_id)
    seen = set()
    for row in rows:
        sid = row["session_id"]
        if sid in seen:
            continue
        seen.add(sid)
        if sid in _HOLDS or sid in running or chat_service.is_busy(sid):
            continue
        header = sstore.get_session_header(sid)
        if header is None or (header[0].get("thread") or {}).get("queue_paused"):
            continue
        return coalesce([r for r in rows if r["session_id"] == sid])
    return None


def coalesce(rows: list[dict]) -> list[dict]:
    """The head row plus the compatible rows that follow it: same person,
    typed (never spoken, relayed or unattended), each within two minutes of the
    one before, at most 30. A row that resumes a saved message runs alone."""
    group = [rows[0]]
    if rows[0].get("message_id") or (rows[0]["payload"].get("mode") in NOT_COALESCED):
        return group
    for row in rows[1:]:
        last = group[-1]
        if (len(group) >= MAX_COALESCE or row.get("message_id") or row["owner"] != last["owner"] or
                row["payload"].get("mode") in NOT_COALESCED or row["created_at"] - last["created_at"] > COALESCE_SECONDS):
            break
        group.append(row)
    return group


async def _dispatch_group(group: list[dict], *, ignore_hold: bool = False) -> tuple[bool, str]:
    """Start one turn for these rows. (True, turn id) or (False, why)."""
    from services.agent_service import agent_service
    first = group[0]
    sid, owner, bot_id = first["session_id"], first["owner"], first["bot_id"]
    payload = store.merged_payload(group)
    context = ""
    if payload.get("references"):
        try:
            context = await _context(owner, sid, payload["references"])
        except (ValueError, HTTPException):
            for row in group:
                store.mark(row["id"], "interrupted")
            store.pause(sid)
            _announce(sid, owner, "references-changed")
            return False, "references"
    context += _phase6_context(bot_id, sid, payload)
    with _ADMISSION:
        bot = agent_service.get(bot_id)
        if bot is None:
            return False, "no-bot"
        if (sid in _HOLDS and not ignore_hold) or chat_live.is_processing(sid):
            return False, "busy"
        if len(running_threads(bot_id, sid)) >= int(bot.get("thread_limit") or 3):
            return False, "capacity"
        try:
            chat_service.claim_session(sid)
        except HTTPException:
            return False, "busy"
        generation = uuid.uuid4().hex
        try:
            index, merged = store.dispatch(group, generation)
        except (store.Conflict, KeyError):
            chat_service.release_session(sid)
            return False, "changed"
        try:
            _launch(owner, sid, bot, merged, index, generation, context)
        except BaseException:
            chat_service.release_session(sid)
            store.fail_dispatch(sid, generation)
            raise
    _announce(sid, owner, "dispatched")
    return True, generation


async def drain(bot_id: str) -> int:
    """Start every queued message that may start now. Safe to call any time."""
    lock = _DRAIN_LOCKS.setdefault(bot_id, asyncio.Lock())
    started = 0
    async with lock:
        for _ in range(64):
            with _ADMISSION:
                group = _eligible_group(bot_id)
            if group is None:
                break
            try:
                ok, _why = await _dispatch_group(group)
            except Exception:
                logger.exception("could not start a queued message of bot %s", bot_id)
                break
            if ok:
                started += 1
    return started


async def startup() -> dict:
    """After a restart: reconcile every uncertain dispatch, then let queues run, in every account (each has
    its own chats and bots, Multi-Account group 4). A drain started here keeps its account."""
    from core import accounts
    recovered = started = 0
    for account_id in accounts.all_accounts():
        with accounts.as_account(account_id):
            for sid in store.sessions_dispatching():
                recovered += recover(sid)
            bots = store.bots_with_pending()
            for bot_id in bots:
                schedule_drain(bot_id)
            started += len(bots)
    return {"recovered": recovered, "bots": started}


def recover(sid: str) -> int:
    run = chat_live.current_turn(sid)
    active = run["turn_id"] if run and run["status"] == "processing" else None
    return store.recover(sid, active)


# -- queue endpoints -------------------------------------------------------------

def queue_view(owner: str, sid: str) -> dict:
    require(owner, sid)
    recover(sid)
    queue = store.queue(owner, sid)
    return {"items": [_queue_item(item) for item in queue["items"]], "revision": queue["revision"],
            "paused": queue["paused"], "consumed_queue_ids": queue["consumed_queue_ids"]}


def queue_cancel(owner: str, sid: str, qid: str) -> dict:
    require(owner, sid)
    try:
        store.change(owner, sid, qid, "cancelled")
    except KeyError:
        raise HTTPException(404, "queued message not found")
    _announce(sid, owner, "cancelled", qid)
    return {"cancelled": True, "queue_id": qid, **queue_view(owner, sid)}


def queue_edit(owner: str, sid: str, qid: str) -> dict:
    """Take a queued message back into the draft: removed from the queue, payload returned."""
    require(owner, sid)
    try:
        item = store.change(owner, sid, qid, "cancelled")
    except KeyError:
        raise HTTPException(404, "queued message not found")
    _announce(sid, owner, "edited", qid)
    return {"queue_id": qid, "draft": _queue_item({**item, "state": "cancelled"}), **queue_view(owner, sid)}


async def queue_resume(owner: str, sid: str) -> dict:
    _session, bot = require(owner, sid)
    recover(sid)
    moved = store.resume(owner, sid)
    _announce(sid, owner, "resumed")
    await drain(bot["id"])
    return {"resumed": moved, **queue_view(owner, sid)}


async def queue_steer(owner: str, sid: str, qid: str, body: dict) -> dict:
    """Run the queue head (or the ordered group at its head) now, interrupting
    the running turn first. Providers have no uniform native steering, so this
    is the supported fallback: interrupt the named turn, wait for it to clean
    up, then start the steering text with the conversation as it stands."""
    _session, bot = require(owner, sid)
    queue = store.queue(owner, sid)
    if body.get("queue_revision") != queue["revision"]:
        raise HTTPException(409, "The queue changed. Reload and try again.")
    items = queue["items"]
    ids = body.get("group_ids") or [qid]
    if not items or items[0]["id"] != qid or ids != [i["id"] for i in items[:len(ids)]]:
        return {"steered": False, "blocked": "not-first"}
    group = items[:len(ids)]
    if len(group) > 1 and any(item.get("message_id") for item in group):
        return {"steered": False, "blocked": "mixed"}
    _HOLDS.add(sid)
    try:
        run = chat_live.current_turn(sid)
        if run and run["status"] == "processing":
            if body.get("turn_id") != run["turn_id"]:
                return {"steered": False, "blocked": "turn-changed"}
            chat_live.stop_turn(sid, run["turn_id"], "steer")
            if not await chat_live.wait_settled(sid, run["turn_id"], STEER_STOP_SECONDS):
                return {"steered": False, "blocked": "stop-timeout"}
        store.release_pause(sid)
        ok, why = await _dispatch_group(group, ignore_hold=True)
        if not ok:
            return {"steered": False, "blocked": why}
        return {"steered": True, "consumed_ids": [item["id"] for item in group], "turn_id": why, "thread_id": sid}
    finally:
        _HOLDS.discard(sid)
        schedule_drain(bot["id"])


def interrupt(owner: str, sid: str, turn_id: str) -> dict:
    """Stop the named turn. A turn that is over, or was replaced, is a harmless no-op."""
    require(owner, sid)
    outcome = chat_live.stop_turn(sid, turn_id, "person")
    if outcome == "stopping":
        try:
            from services import bot_goal_runs
            bot_goal_runs.note_interrupt(sid, turn_id)
        except Exception:
            logger.exception("goal stop bookkeeping failed for %s", sid)
    return {"outcome": outcome, "turn_id": turn_id}


# -- reading ---------------------------------------------------------------------

_HIDDEN_KEYS = ("tool_rounds", "sent", "image_attachment_ids")
_TYPED_ROWS = ("handoff", "fd_card", "bot_created")


def client_message(row: dict, owner: str, versions: dict | None = None) -> dict:
    message = {key: value for key, value in row.items() if key not in _HIDDEN_KEYS}
    # Rows other services post with a `type` (a handoff, a front-desk card, a bot made from the chat) draw as that kind.
    if not message.get("kind") and row.get("type") in _TYPED_ROWS:
        message["kind"] = row["type"]
    message["id"] = row.get("bot_message_id")
    message["reply_to"] = row.get("reply_to_id")
    message["reactions"] = reaction_list(row.get("reactions"), owner)
    if versions and row.get("bot_message_id") in versions:
        found = versions[row["bot_message_id"]]
        # The tree counts from 1; the page counts from 0 (botsMessageActions.versionSwitcher shows index + 1 of count).
        message["version"] = {"index": found["index"] - 1, "count": found["total"], "ids": found["ids"]}
    return message


def reaction_list(reactions: dict | None, owner: str) -> list[dict]:
    """[{emoji, count, mine}] for the emoji in use, in the fixed order of REACTIONS."""
    reactions = reactions or {}
    return [{"emoji": emoji, "count": sum(1 for value in reactions.values() if value == emoji),
             "mine": reactions.get(owner) == emoji} for emoji in REACTIONS if emoji in reactions.values()]


def messages(owner: str, sid: str, limit: int = PAGE_DEFAULT, before: str | None = None,
             around: str | None = None, after: str | None = None) -> dict:
    """A page of the active branch, oldest first, with cursors. `around` centres
    on a message of the active branch; a message of another version is a 409
    that names the leaf to select first."""
    session, _bot = require(owner, sid)
    recover(sid)
    session = tree.ensure(sid)
    limit = max(1, min(int(limit), PAGE_MAX))
    path = tree.ancestry(session)
    ids = [row["bot_message_id"] for row in path]
    if around is not None:
        if around not in ids:
            if any(m.get("bot_message_id") == around for m in session["messages"]):
                raise HTTPException(409, "That message is in another version.",
                                    headers={"X-Branch-Leaf": tree.leaf_under(session, around)})
            raise HTTPException(404, "message not found")
        centre = ids.index(around)
        start = max(0, min(centre - limit // 2, len(ids) - limit))
        end = min(len(ids), start + limit)
    elif after is not None:
        if after not in ids:
            raise HTTPException(404, "message not found")
        start = ids.index(after) + 1
        end = min(len(ids), start + limit)
    elif before is not None:
        if before not in ids:
            raise HTTPException(404, "message not found")
        end = ids.index(before)
        start = max(0, end - limit)
    else:
        end = len(ids)
        start = max(0, end - limit)
    versions = tree.versions(session, path)
    thread = session["thread"]
    return {"messages": [client_message(row, owner, versions) for row in path[start:end]],
            "has_before": start > 0, "has_after": end < len(ids), "first_id": ids[start] if ids[start:end] else None,
            "last_id": ids[end - 1] if ids[start:end] else None, "total": len(ids),
            "active_leaf_id": thread["active_leaf_id"], "branch_revision": thread["branch_revision"],
            "pinned_message_id": thread.get("pinned_message_id"),
            "last_read_message_id": thread.get("last_read_message_id")}


def state(owner: str, sid: str) -> dict:
    session, bot = require(owner, sid)
    recover(sid)
    session = tree.ensure(sid)
    thread = session["thread"]
    endpoint = chat_service._resolve_endpoint(sid)
    override = session.get("model_override")
    from services import bot_goal_runs
    turn = chat_live.current_turn(sid)
    queue = store.queue(owner, sid)
    return {"session_id": sid, "bot_id": bot["id"], "active_leaf_id": thread["active_leaf_id"],
            "branch_revision": thread["branch_revision"],
            "turn": ({"id": turn["turn_id"], **{k: turn[k] for k in ("turn_id", "status", "stopping", "started_at", "permission")}}
                     if turn else None),
            "context": _context_view(session, endpoint),
            "queue": {"items": [_queue_item(i) for i in queue["items"]], "revision": queue["revision"],
                      "paused": queue["paused"], "consumed_queue_ids": queue["consumed_queue_ids"]},
            "goal": bot_goal_runs.current(sid),
            "model": ({"label": " ".join(filter(None, [endpoint.get("name"), (endpoint.get("model") if override in (None, "") else override)])),
                       "endpoint_id": endpoint["id"], "name": endpoint.get("name"), "kind": endpoint["kind"],
                       "model": (endpoint.get("model") if override in (None, "") else override) or None,
                       "effort": session.get("model_effort")} if endpoint else None),
            "capabilities": {"queue": True, "steer": "interrupt", "edit": True, "regenerate": True,
                             "images": bool(endpoint and (endpoint["kind"] not in ("local", "api") or endpoint.get("supports_images"))),
                             "compact": True, "thread_limit": int(bot.get("thread_limit") or 3),
                             "steer_hint": "This stops the current reply, then sends your message."},
            "pinned_message_id": thread.get("pinned_message_id"),
            "last_read_message_id": thread.get("last_read_message_id")}


def _context_view(session: dict, endpoint: dict | None = None) -> dict:
    """The context meter the header shows: percent used when a turn has measured it, else None. `auto`
    when the conversation compacts itself, so the header asks nothing of the person: a local or API model
    with auto-compaction on (services/chat_service.py, in the background), or a CLI that manages its own
    context."""
    meter = session.get("context_state") or {}
    kind = (endpoint or {}).get("kind")
    auto = kind in ("claude_cli", "codex_cli", "antigravity_cli")
    if kind in chat_service.AUTO_COMPACT_KINDS:
        from core import settings as settings_store
        auto = bool(settings_store.get_setting("auto_compact"))
    return {"percent": meter.get("percent") if isinstance(meter.get("percent"), (int, float)) else None,
            "auto": auto}


# -- branches --------------------------------------------------------------------

async def _quiet(sid: str) -> None:
    """Claim an idle thread and close its brain, so a branch change is replayed
    from the saved tree. 409 when the thread is busy."""
    if chat_live.is_processing(sid) or sid in _HOLDS:
        raise HTTPException(409, REASON_TEXT["busy"])
    try:
        chat_service.claim_session(sid)
    except HTTPException:
        raise HTTPException(409, REASON_TEXT["busy"])
    try:
        await chat_service.close_session_brain(sid)
    except BaseException:
        chat_service.release_session(sid)
        raise


async def edit_message(owner: str, sid: str, message_id: str, body: dict) -> dict:
    """Edit a question: a sibling with the original's parent, then a new reply.
    The old version and its answers stay and can be selected again."""
    _session, bot = require(owner, sid)
    session = tree.ensure(sid)
    try:
        _index, row = tree.message(session, message_id)
    except KeyError:
        raise HTTPException(404, "message not found")
    payload = _clean_payload({**body, "attachment_ids": body.get("attachment_ids") or [a["id"] for a in row.get("attachments") or []]})
    shown = {**_shown(payload), "edit_of": message_id}
    earlier = store.receipt(owner, sid, payload["send_id"], shown)
    if earlier is not None:
        return {**earlier, "replayed": True}
    if row.get("role") != "user" or message_id not in {m["bot_message_id"] for m in tree.ancestry(session)}:
        raise HTTPException(409, "Only a question in the selected version can be edited")
    _check_send(sid, payload)
    context = await _context(owner, sid, payload["references"])
    await _quiet(sid)
    return _admit(owner, sid, bot, payload, context, direct_only=True, claimed=True, parent=row.get("parent_id"),
                  expected_revision=body.get("expected_revision"), shown=shown)


async def regenerate(owner: str, sid: str, body: dict) -> dict:
    """Answer the last question again as an alternative. The earlier answer stays."""
    _session, bot = require(owner, sid)
    shown = {"kind": "regenerate"}
    earlier = store.receipt(owner, sid, body["send_id"], shown)
    if earlier is not None:
        return {**earlier, "replayed": True}
    session = tree.ensure(sid)
    path = [m for m in tree.ancestry(session) if not m.get("display_only")]
    if len(path) < 2 or path[-1].get("role") != "assistant":
        raise HTTPException(409, "There is no answer to redo")
    question = next((m for m in session["messages"] if m.get("bot_message_id") == path[-1].get("parent_id")), None)
    if question is None or question.get("role") != "user":
        raise HTTPException(409, "There is no answer to redo")
    row_text = question.get("content") or ""
    payload = {"send_id": body["send_id"], "text": row_text, "expected_leaf_id": body.get("expected_leaf_id"),
               "attachment_ids": [a["id"] for a in question.get("attachments") or []],
               "reply_to_id": question.get("reply_to_id"), "citations": question.get("citations") or [],
               "references": [], "mode": None, "regenerate_of": path[-1]["bot_message_id"]}
    chat_service.validate_image_attachments(sid, payload["attachment_ids"])
    await _quiet(sid)
    return _admit(owner, sid, bot, payload, "", direct_only=True, claimed=True,
                  existing_message_id=question["bot_message_id"], expected_revision=body.get("expected_revision"),
                  shown=shown)


async def select_branch(owner: str, sid: str, body: dict) -> dict:
    """Show another version. The newest leaf at or below the chosen message becomes active."""
    require(owner, sid)
    await _quiet(sid)
    try:
        tree.select(sid, body["message_id"], body["expected_revision"])
    except KeyError:
        raise HTTPException(404, "message not found")
    finally:
        chat_service.release_session(sid)
    _announce_branch(sid, owner)
    return messages(owner, sid)


def _announce_branch(sid: str, owner: str) -> None:
    thread = sstore.get_session_header(sid)[0]["thread"]
    chat_live.broadcast_owner({"type": "bot_branch", "sessionId": sid, "activeLeafId": thread["active_leaf_id"],
                               "branchRevision": thread["branch_revision"]})


# -- reactions, pin, read --------------------------------------------------------

def react(owner: str, sid: str, message_id: str, emoji: str, on: bool) -> dict:
    """One of six emoji per person per message; choosing another replaces it."""
    require(owner, sid)
    if emoji not in REACTIONS:
        raise ValueError("Choose one of: " + ", ".join(REACTIONS))
    with sstore.transaction():
        session = tree.ensure(sid)
        try:
            index, row = tree.message(session, message_id)
        except KeyError:
            raise HTTPException(404, "message not found")
        reactions = dict(row.get("reactions") or {})
        if on:
            reactions[owner] = emoji
        elif reactions.get(owner) == emoji:
            reactions.pop(owner)
        sstore.update_message_fields(sid, index, {"reactions": reactions})
    return {"message_id": message_id, "reactions": reaction_list(reactions, owner)}


def pin(owner: str, sid: str, message_id: str | None) -> dict:
    require(owner, sid)
    session = tree.ensure(sid)
    index = None
    if message_id is not None:
        try:
            index, _row = tree.message(session, message_id)
        except KeyError:
            raise HTTPException(404, "message not found")
    session_manager.update_thread(sid, lambda t: t.update(pinned_message_id=message_id, pinned_message_index=index))
    return {"pinned_message_id": message_id}


def mark_read(owner: str, sid: str, message_id: str | None) -> dict:
    """Move the read cursor forward only. Reading everything clears the unread dot."""
    require(owner, sid)
    session = tree.ensure(sid)
    path = tree.ancestry(session)
    ids = {row["bot_message_id"]: i for i, row in enumerate(path)}
    target = message_id or (path[-1]["bot_message_id"] if path else None)
    if target is not None and target not in ids:
        raise HTTPException(409, "That message is not in the selected version")
    thread = session["thread"]
    current = thread.get("last_read_message_id")
    if target is None or (current in ids and ids[current] >= ids[target]):
        return {"last_read_message_id": current, "unread": bool(thread.get("unread"))}
    unread = any(row.get("role") == "assistant" and not row.get("display_only") for row in path[ids[target] + 1:])
    physical = tree.message(session, target)[0]
    session_manager.update_thread(sid, lambda t: t.update(last_read_message_id=target, last_read_index=physical,
                                                          unread=unread))
    try:
        from services import bot_attention
        bot_attention.mark_thread_read(owner, sid, target)
    except (ImportError, AttributeError):
        pass  # the attention projection (another unit) is not installed yet
    except Exception:
        logger.exception("could not mark the feed read for %s", sid)
    return {"last_read_message_id": target, "unread": unread}


# -- compact, export, search, presence -------------------------------------------

async def compact(owner: str, sid: str) -> dict:
    """Idle-only compaction of the selected version."""
    require(owner, sid)
    if chat_live.is_processing(sid) or chat_service.is_busy(sid) or sid in _HOLDS:
        raise HTTPException(409, REASON_TEXT["busy"])
    result = await chat_service.compact_session(sid)
    return {**{k: v for k, v in result.items() if k != "summary"}, "summary": result.get("summary")}


def export(owner: str, sid: str, fmt: str = "markdown") -> dict:
    """The selected version, newest 2,000 messages, with credentials redacted."""
    from core import logs
    session, bot = require(owner, sid)
    path = [m for m in tree.ancestry(tree.ensure(sid)) if m.get("role") in ("user", "assistant")][-EXPORT_MAX:]
    rows = []
    for row in path:
        rows.append({"id": row["bot_message_id"], "parent_id": row.get("parent_id"), "role": row["role"],
                     "ts": row.get("ts"), "status": row.get("status"),
                     "content": logs.scrub_credentials(row.get("content") or ""),
                     "attachments": [a.get("filename") for a in row.get("attachments") or []]})
    if fmt == "json":
        return {"format": "json", "bot": bot["name"], "title": session.get("title"), "messages": rows}
    lines = [f"# {session.get('title') or 'Conversation'}", ""]
    for row in rows:
        who = "You" if row["role"] == "user" else bot["name"]
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(row["ts"])) if row["ts"] else ""
        lines += [f"**{who}** {when}".strip(), "", row["content"] or "(no text)", ""]
        if row["attachments"]:
            lines += ["Attachments: " + ", ".join(row["attachments"]), ""]
    return {"format": "markdown", "bot": bot["name"], "title": session.get("title"), "text": "\n".join(lines)}


def _search_worker(owner: str, q: str, bot_id: str | None, sid: str | None, limit: int) -> list[dict]:
    needle = q.lower()
    with _SEARCH_SLOTS:
        with sstore.transaction() as conn:
            clauses, args = ["s.agent_id IS NOT NULL", "m.role IN ('user','assistant')",
                             "instr(lower(m.content), ?) > 0"], [needle]
            if bot_id:
                clauses.append("s.agent_id = ?")
                args.append(bot_id)
            if sid:
                clauses.append("s.id = ?")
                args.append(sid)
            rows = conn.execute(
                "SELECT m.session_id, m.idx, m.role, m.content, m.ts, m.doc, s.title, s.agent_id, s.doc AS sdoc "
                "FROM messages m JOIN sessions s ON s.id = m.session_id WHERE " + " AND ".join(clauses) +
                " ORDER BY m.ts DESC LIMIT ?", (*args, limit * 3)).fetchall()
            hits, paths = [], {}
            for row in rows:
                session_doc = json.loads(row["sdoc"])
                if session_doc.get("owner_user") not in (owner, None) and not _is_admin(owner):
                    continue
                doc = json.loads(row["doc"])
                mid = doc.get("bot_message_id")
                if row["session_id"] not in paths:
                    parents = {r[0]: r[1] for r in conn.execute(
                        "SELECT json_extract(doc,'$.bot_message_id'), json_extract(doc,'$.parent_id') "
                        "FROM messages WHERE session_id=?", (row["session_id"],))}
                    chain, leaf = set(), (session_doc.get("thread") or {}).get("active_leaf_id")
                    while leaf is not None and leaf in parents and leaf not in chain:
                        chain.add(leaf)
                        leaf = parents[leaf]
                    paths[row["session_id"]] = chain
                active = mid in paths[row["session_id"]] if paths[row["session_id"]] else True
                content = row["content"] or ""
                at = content.lower().find(needle)
                hits.append({"session_id": row["session_id"], "bot_id": row["agent_id"], "title": row["title"],
                             "message_id": mid, "leaf_id": _leaf_of(parents, mid), "role": row["role"], "ts": row["ts"], "active": active,
                             "other_version": not active,
                             "snippet": ("..." if at > 60 else "") + content[max(0, at - 60):at + len(needle) + 100]})
                if len(hits) >= limit:
                    break
            return hits


def _leaf_of(parents: dict, message_id: str) -> str:
    """The newest leaf at or below a message, from a parent map: what selecting that hit shows."""
    children: dict = {}
    for child, parent in parents.items():
        children.setdefault(parent, []).append(child)
    current = message_id
    while children.get(current):
        current = children[current][-1]
    return current


def _is_admin(owner: str) -> bool:
    from core.auth import auth_manager
    return auth_manager.is_admin(owner)


async def search(owner: str, q: str, bot_id: str | None = None, session_id: str | None = None,
                 limit: int = 40) -> dict:
    """Literal text search over bot conversations, including other versions.
    Runs in a bounded worker pool: at most 2 searching and 8 waiting."""
    global _search_pending
    q = (q or "").strip()
    if not q or len(q) > 200:
        raise ValueError("Search for 1 to 200 characters")
    if session_id:
        require(owner, session_id)
    if _search_pending >= SEARCH_PENDING_MAX:
        raise HTTPException(503, "Search is busy. Try again in a moment.")
    _search_pending += 1
    try:
        hits = await asyncio.wait_for(asyncio.to_thread(_search_worker, owner, q, bot_id, session_id,
                                                        max(1, min(int(limit), 100))), 30)
    finally:
        _search_pending -= 1
    return {"query": q, "hits": hits}


def presence(owner: str, body: dict) -> dict:
    """Timezone, language and the focused thread. Clients ping at most once a
    minute; a repeat inside that window is acknowledged and ignored."""
    zone = body.get("timezone")
    if zone is not None:
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone")
    focused = body.get("focused_thread")
    if focused:
        require(owner, focused)
    now = time.time()
    last = _PRESENCE.get(owner)
    entry = {"timezone": zone, "language": body.get("language"), "focused_thread": focused, "at": now}
    if last and now - last["at"] < PRESENCE_MIN_SECONDS and all(
            last[k] == entry[k] for k in ("timezone", "language", "focused_thread")):
        return {"ok": True, "throttled": True}
    _PRESENCE[owner] = entry
    return {"ok": True, "throttled": False}


def presence_of(owner: str) -> dict | None:
    """What the person last told us: for snoozes and focused-thread alert suppression."""
    entry = _PRESENCE.get(owner)
    return dict(entry) if entry else None
