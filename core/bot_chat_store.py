"""Durable Bots receipts and follow-ups on the sessions database.

Every mutation composes with session writes through savepoint transactions,
so a send receipt, the accepted message and its queue row commit together or
not at all. No model execution happens while a database transaction is open.

Queue states: pending, dispatching, cancelled, interrupted, consumed. The
newest KEPT_TOMBSTONES finished rows per thread stay, so a late retry cannot
put a drained message back.
"""
import hashlib
import json
import time
import uuid

from core import bot_message_tree as tree, session_manager_store as store
from core.session_manager import session_manager

KEPT_TOMBSTONES = 64
WAITING = ("pending", "interrupted")
_UNSET = object()


class Conflict(ValueError):
    """The request no longer matches stored state (an HTTP 409)."""


def fingerprint(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def receipt(owner: str, sid: str, send_id: str, payload: dict) -> dict | None:
    """The stored result of an earlier send with this ID, None when new.
    The same ID with a different message is a conflict."""
    with store.transaction() as conn:
        row = conn.execute("SELECT fingerprint,result FROM bot_send_receipts WHERE owner=? AND session_id=? AND send_id=?",
                           (owner, sid, send_id)).fetchone()
        if not row:
            return None
        if row["fingerprint"] != fingerprint(payload):
            raise Conflict("This send ID was already used for a different message")
        return json.loads(row["result"])


def _bump(sid: str, **fields) -> int:
    """Raise the thread's queue revision (and set other thread fields) without
    reading the transcript."""
    def apply(thread):
        thread["queue_revision"] = thread.get("queue_revision", 0) + 1
        thread.update(fields)
    return session_manager.update_thread(sid, apply)["queue_revision"]


def _reset_provider(sid: str) -> None:
    """Forget every provider-side copy of the conversation (a branch change)."""
    session = store.get_session(sid)
    tree.reset_provider(session)
    store.save_session(session, store.MESSAGES_UNCHANGED)


def append_accepted(sid: str, payload: dict, parent_id=_UNSET) -> int:
    from core import chat_references
    from services.chat_service import _user_message_extra
    saved = chat_references.metadata(payload.get("references") or []) if payload.get("references") else None
    extra = {**_user_message_extra(saved, payload.get("attachment_ids")),
             "bot_send_id": payload["send_id"], "reply_to_id": payload.get("reply_to_id"),
             "citations": payload.get("citations") or [], "mode": payload.get("mode")}
    if payload.get("goal_step"):
        extra["goal_step"] = payload["goal_step"]
        extra["goal_root"] = payload.get("goal_root")
    if parent_id is not _UNSET:
        extra["parent_id"] = parent_id
    return session_manager.append_message(sid, "user", payload["text"], extra=extra)


def _prune(conn, sid: str) -> None:
    conn.execute("DELETE FROM bot_followups WHERE session_id=? AND state IN ('consumed','cancelled') AND id NOT IN "
                 "(SELECT id FROM bot_followups WHERE session_id=? AND state IN ('consumed','cancelled') "
                 "ORDER BY sequence DESC LIMIT ?)", (sid, sid, KEPT_TOMBSTONES))


def accept(owner: str, sid: str, payload: dict, reason: str | None, generation: str, *,
           parent_id=_UNSET, existing_message_id: str | None = None,
           expected_revision: int | None = None, fingerprint_payload: dict | None = None) -> dict:
    """Record a send atomically: its receipt, the user message (or, queued, the
    queue row only) and the follow-up row. A retry with the same send ID gets
    the first result back. `existing_message_id` re-runs a message that is
    already saved (regenerate): nothing is appended and it becomes the leaf."""
    with store.transaction() as conn:
        shown = fingerprint_payload or payload
        existing = receipt(owner, sid, payload["send_id"], shown)
        if existing is not None:
            return {**existing, "replayed": True}
        session = tree.ensure(sid)
        thread = session["thread"]
        if thread["active_leaf_id"] != payload.get("expected_leaf_id"):
            raise Conflict("Conversation changed. Reload and try again.")
        if expected_revision is not None and thread["branch_revision"] != expected_revision:
            raise Conflict("Conversation changed. Reload and try again.")
        qid = uuid.uuid4().hex
        result = {"accepted": True, "send_id": payload["send_id"], "session_id": sid,
                  "queued": bool(reason), "queue_id": qid if reason else None, "reason": reason,
                  "turn_id": None if reason else generation}
        message_id = None
        if existing_message_id:
            index, message = tree.message(session, existing_message_id)
            message_id = existing_message_id
            if thread["active_leaf_id"] != message_id:
                session_manager.update_thread(sid, lambda t: t.update(
                    active_leaf_id=message_id, branch_revision=t.get("branch_revision", 0) + 1))
            _reset_provider(sid)
            result.update(message=message, message_id=message_id, message_index=index)
        elif not reason:
            index = append_accepted(sid, payload, parent_id)
            message = store.get_message(sid, index)
            message_id = message["bot_message_id"]
            if parent_id is not _UNSET:
                _reset_provider(sid)  # an edit starts a new branch the provider has not seen
            result.update(message=message, message_id=message_id, message_index=index)
        conn.execute("INSERT INTO bot_followups(id,owner,bot_id,session_id,send_id,payload,state,generation,message_id,created_at) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (qid, owner, session["agent_id"], sid, payload["send_id"], json.dumps(payload),
                      "pending" if reason else "dispatching", None if reason else generation, message_id, time.time()))
        _bump(sid)
        current = store.get_session_header(sid)[0]["thread"]
        result.update(active_leaf_id=current["active_leaf_id"], branch_revision=current["branch_revision"],
                      queue_revision=current.get("queue_revision", 0))
        conn.execute("INSERT INTO bot_send_receipts VALUES(?,?,?,?,?)",
                     (owner, sid, payload["send_id"], fingerprint(shown), json.dumps(result)))
        return result


def _decode(row) -> dict:
    result = dict(row)
    result["payload"] = json.loads(result["payload"])
    return result


def queue(owner: str, sid: str) -> dict:
    with store.transaction() as conn:
        rows = conn.execute("SELECT * FROM bot_followups WHERE owner=? AND session_id=? AND state IN ('pending','interrupted') "
                            "ORDER BY sequence", (owner, sid)).fetchall()
        done = conn.execute("SELECT id FROM bot_followups WHERE owner=? AND session_id=? AND state IN ('consumed','cancelled') "
                            "ORDER BY sequence DESC LIMIT ?", (owner, sid, KEPT_TOMBSTONES)).fetchall()
        header = store.get_session_header(sid)
        thread = header[0].get("thread") or {} if header else {}
        return {"items": [_decode(r) for r in rows], "revision": thread.get("queue_revision", 0),
                "paused": bool(thread.get("queue_paused", False)), "consumed_queue_ids": [r["id"] for r in done]}


def pending(bot_id: str) -> list[dict]:
    """Every waiting-to-run row of one bot, oldest first, across its threads."""
    with store.transaction() as conn:
        return [_decode(r) for r in conn.execute(
            "SELECT * FROM bot_followups WHERE bot_id=? AND state='pending' ORDER BY sequence", (bot_id,))]


def waiting_count(sid: str) -> int:
    with store.transaction() as conn:
        return conn.execute("SELECT COUNT(*) FROM bot_followups WHERE session_id=? AND state IN ('pending','interrupted')",
                            (sid,)).fetchone()[0]


def bots_with_pending() -> list[str]:
    with store.transaction() as conn:
        return [r[0] for r in conn.execute("SELECT DISTINCT bot_id FROM bot_followups WHERE state='pending'")]


def sessions_dispatching() -> list[str]:
    with store.transaction() as conn:
        return [r[0] for r in conn.execute("SELECT DISTINCT session_id FROM bot_followups WHERE state='dispatching'")]


def get(owner: str, sid: str, qid: str) -> dict:
    with store.transaction() as conn:
        row = conn.execute("SELECT * FROM bot_followups WHERE id=? AND owner=? AND session_id=?", (qid, owner, sid)).fetchone()
        if row is None:
            raise KeyError(qid)
        return _decode(row)


def change(owner: str, sid: str, qid: str, state: str, expected_revision: int | None = None) -> dict:
    """Cancel a waiting row (state 'cancelled', which stays as a tombstone)."""
    with store.transaction() as conn:
        row = conn.execute("SELECT * FROM bot_followups WHERE id=? AND owner=? AND session_id=?", (qid, owner, sid)).fetchone()
        if row is None:
            raise KeyError(qid)
        if row["state"] not in WAITING:
            raise Conflict("This queued message has already changed")
        conn.execute("UPDATE bot_followups SET state=? WHERE id=?", (state, qid))
        _bump(sid)
        _prune(conn, sid)
        return _decode(row)


def merged_payload(items: list[dict]) -> dict:
    """One send's payload from several queued rows (their texts in order). Each
    row keeps its own receipt; only the model sees them joined."""
    payload = dict(items[0]["payload"])
    payload["text"] = "\n\n".join(item["payload"]["text"] for item in items)
    for key in ("attachment_ids", "references", "citations"):
        joined = []
        for item in items:
            for value in item["payload"].get(key) or []:
                if value not in joined:
                    joined.append(value)
        payload[key] = joined
    # Phase 6: the newest open data result counts, and pointed app parts join up to five.
    contexts = [item["payload"]["data_context"] for item in items if item["payload"].get("data_context")]
    if contexts:
        payload["data_context"] = contexts[-1]
    pointed = [p for item in items for p in item["payload"].get("pointed") or []][:5]
    if pointed:
        payload["pointed"] = pointed
    return payload


def dispatch(items: list[dict], generation: str) -> tuple[int, dict]:
    """Accept waiting rows and mark them dispatching atomically, in order.
    A row whose message is already saved (a Resume after a restart) runs that
    message again instead of appending a second copy."""
    with store.transaction() as conn:
        sid = items[0]["session_id"]
        first = items[0]
        if first.get("message_id"):
            session = tree.ensure(sid)
            index, message = tree.message(session, first["message_id"])
            if session["thread"]["active_leaf_id"] != first["message_id"]:
                session_manager.update_thread(sid, lambda t: t.update(
                    active_leaf_id=first["message_id"], branch_revision=t.get("branch_revision", 0) + 1))
            _reset_provider(sid)
            payload, mid = dict(first["payload"]), first["message_id"]
        else:
            payload = merged_payload(items)
            index = append_accepted(sid, payload)
            mid = store.get_message(sid, index)["bot_message_id"]
        for item in items:
            updated = conn.execute("UPDATE bot_followups SET state='dispatching',generation=?,message_id=? "
                                   "WHERE id=? AND state IN ('pending','interrupted')", (generation, mid, item["id"]))
            if updated.rowcount != 1:
                raise Conflict("The queue changed")
        _bump(sid)
        return index, payload


def terminal(sid: str, generation: str, *, pause: bool = False) -> None:
    """A turn ended: its rows are consumed. Stop and failure also pause automatic draining."""
    with store.transaction() as conn:
        conn.execute("UPDATE bot_followups SET state='consumed' WHERE session_id=? AND generation=? AND state='dispatching'",
                     (sid, generation))
        _bump(sid, **({"queue_paused": True} if pause else {}))
        _prune(conn, sid)


def recover(sid: str, active_generation: str | None) -> int:
    """After a restart: a dispatching row with no live turn is reconciled
    against its message. Answered work is consumed; unresolved work becomes an
    interrupted row the person must Resume. Never replayed automatically."""
    changed = 0
    with store.transaction() as conn:
        rows = conn.execute("SELECT * FROM bot_followups WHERE session_id=? AND state='dispatching'", (sid,)).fetchall()
        if not rows:
            return 0
        session = tree.ensure(sid)
        paused = False
        for row in rows:
            if row["generation"] == active_generation:
                continue
            answered = any(m.get("parent_id") == row["message_id"] and m.get("role") == "assistant" and
                           m.get("status") not in ("failed", "interrupted") and not m.get("display_only")
                           for m in session["messages"])
            conn.execute("UPDATE bot_followups SET state=?,generation=NULL WHERE id=?",
                         ("consumed" if answered else "interrupted", row["id"]))
            paused = paused or not answered
            changed += 1
        if changed:
            _bump(sid, **({"queue_paused": True} if paused else {}))
    return changed


def resume(owner: str, sid: str) -> int:
    """Return interrupted rows to the queue and release the pause."""
    with store.transaction() as conn:
        moved = conn.execute("UPDATE bot_followups SET state='pending',generation=NULL WHERE owner=? AND session_id=? "
                             "AND state='interrupted'", (owner, sid)).rowcount
        _bump(sid, queue_paused=False)
        return moved


def release_pause(sid: str) -> None:
    _bump(sid, queue_paused=False)


def pause(sid: str) -> None:
    _bump(sid, queue_paused=True)


def mark(qid: str, state: str) -> None:
    """Set one row's state directly (a row that cannot run as saved is interrupted)."""
    with store.transaction() as conn:
        row = conn.execute("SELECT session_id FROM bot_followups WHERE id=?", (qid,)).fetchone()
        conn.execute("UPDATE bot_followups SET state=? WHERE id=?", (state, qid))
        if row:
            _bump(row["session_id"])


def fail_dispatch(sid: str, generation: str) -> None:
    """A turn could not start after its message was accepted: the rows wait for an
    explicit Resume instead of being lost or replayed."""
    with store.transaction() as conn:
        conn.execute("UPDATE bot_followups SET state='interrupted',generation=NULL WHERE session_id=? AND generation=? "
                     "AND state='dispatching'", (sid, generation))
        _bump(sid, queue_paused=True)


def reply_to(sid: str, message_id: str) -> tuple[int, dict] | None:
    """(row index, message) of the newest real assistant reply to a message, or None."""
    with store.transaction() as conn:
        row = conn.execute(
            "SELECT idx, doc FROM messages WHERE session_id=? AND role='assistant' "
            "AND json_extract(doc,'$.parent_id')=? AND json_extract(doc,'$.display_only') IS NULL "
            "ORDER BY idx DESC LIMIT 1", (sid, message_id)).fetchone()
    return (row["idx"], json.loads(row["doc"])) if row else None
