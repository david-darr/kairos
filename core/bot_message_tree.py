"""Stable message identity and non-destructive conversation ancestry.

Physical indices remain the legacy storage contract. IDs are the Bots contract.
"""
import uuid

from core import session_manager_store as store


def upgrade(session: dict) -> bool:
    changed = False
    parent = None
    for index, message in enumerate(session.get("messages") or []):
        if not message.get("bot_message_id"):
            message["bot_message_id"] = uuid.uuid5(uuid.NAMESPACE_URL, f"kairos:{session['id']}:{index}").hex
            message.setdefault("parent_id", parent)
            changed = True
        parent = message["bot_message_id"]
    thread = session.setdefault("thread", {})
    defaults = {"active_leaf_id": parent, "branch_revision": 0,
                "last_read_message_id": None, "pinned_message_id": None}
    for key, value in defaults.items():
        if key not in thread:
            thread[key] = value
            changed = True
    # Old compactions referred to physical prefixes. Bind each to its boundary.
    for checkpoint in session.get("compactions") or []:
        if "folded_through_id" not in checkpoint:
            end = checkpoint.get("through_index", 0)
            checkpoint["folded_through_id"] = session["messages"][end - 1]["bot_message_id"] if end else None
            changed = True
    return changed


def ensure(session_id: str) -> dict:
    with store.transaction():
        session = store.get_session(session_id)
        if session is None:
            raise KeyError(session_id)
        if upgrade(session):
            store.save_session(session)
        return session


def ancestry(session: dict, leaf_id=None, *, explicit=False) -> list[dict]:
    rows = session.get("messages") or []
    if not session.get("agent_id") or "active_leaf_id" not in (session.get("thread") or {}):
        return list(rows)
    leaf = leaf_id if explicit else session["thread"]["active_leaf_id"]
    by_id = {m["bot_message_id"]: m for m in rows if m.get("bot_message_id")}
    path, seen = [], set()
    while leaf is not None:
        if leaf in seen or leaf not in by_id:
            raise ValueError("Invalid conversation ancestry")
        seen.add(leaf)
        message = by_id[leaf]
        path.append(message)
        leaf = message.get("parent_id")
    return list(reversed(path))


def message(session: dict, message_id: str) -> tuple[int, dict]:
    for index, row in enumerate(session.get("messages") or []):
        if row.get("bot_message_id") == message_id:
            return index, row
    raise KeyError(message_id)


def checkpoints(session: dict, path: list[dict]) -> list[dict]:
    """Compaction checkpoints whose boundary lies on this ancestry, newest last.
    A fold made on another branch never applies here."""
    ids = {m.get("bot_message_id") for m in path}
    return [c for c in session.get("compactions") or [] if c.get("folded_through_id") in ids]


def boundary(path: list[dict], checkpoint: dict) -> int:
    """How many leading messages of `path` a checkpoint stands for."""
    folded = checkpoint.get("folded_through_id")
    if folded is None:
        return 0
    return next(i + 1 for i, m in enumerate(path) if m.get("bot_message_id") == folded)


def children(session: dict) -> dict:
    """parent id -> child ids in storage order (None is the root's key)."""
    result: dict = {}
    for row in session.get("messages") or []:
        if row.get("bot_message_id"):
            result.setdefault(row.get("parent_id"), []).append(row["bot_message_id"])
    return result


def leaf_under(session: dict, message_id: str) -> str:
    """The newest leaf at or below a message: what choosing a version shows."""
    kids = children(session)
    current = message_id
    while kids.get(current):
        current = kids[current][-1]
    return current


def versions(session: dict, path: list[dict]) -> dict:
    """message id -> {index, total, ids} for every message on `path` that has
    siblings (an edited question, a regenerated answer)."""
    kids = children(session)
    found = {}
    for row in path:
        siblings = kids.get(row.get("parent_id"), [])
        if len(siblings) > 1:
            found[row["bot_message_id"]] = {"index": siblings.index(row["bot_message_id"]) + 1,
                                            "total": len(siblings), "ids": list(siblings)}
    return found


def reset_provider(session: dict) -> None:
    for key in ("claude_session_id", "codex_thread_id", "antigravity_conversation_id", "context_state"):
        session[key] = None
    session["claude_synced_through"] = 0


class Stale(ValueError):
    """The caller's view of the conversation is out of date (an HTTP 409)."""


def select(session_id: str, message_id: str | None, revision: int) -> dict:
    """Make the newest leaf at or below `message_id` the active one. Nothing is deleted."""
    with store.transaction():
        session = ensure(session_id)
        thread = session["thread"]
        if thread["branch_revision"] != revision:
            raise Stale("Conversation changed. Reload and try again.")
        if message_id is not None:
            message(session, message_id)
            message_id = leaf_under(session, message_id)
        ancestry(session, message_id, explicit=True)
        thread["active_leaf_id"] = message_id
        thread["branch_revision"] += 1
        reset_provider(session)
        return store.save_session(session, store.MESSAGES_UNCHANGED)
