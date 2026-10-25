"""Folders dropped on the desktop notch (Kairos Notch build spec, 4a and 6).

A folder means handing a path to the model, which is a standing file grant,
so it always goes through the permissions broker (core/permissions.py) as a
path-root grant before the chat may use it:

- once: a rule for this chat only, held in memory with the chat's other
  session rules and dropped when the chat is deleted or Kairos restarts;
- always: a saved rule for exactly this folder, listed and revocable in
  Settings > Permissions, so the next drop of it is not asked again;
- reject: nothing is attached.

The chat then gets the path and a capped listing of names, as a reference
the composer sends. Never the folder's contents: the model reads a file only
through its own tools, which keep their own rules. Every send checks the
broker again, so revoking the rule stops the folder at the next message.
"""
import os
import re
import uuid

from core import permissions

TOOL = "folder_access"
LISTING_LIMIT = 200
LISTING_DEPTH = 2
MAX_PATH = 1024

# grant id -> {session_id, path, user}. Ids are server-made, so a reference
# names a grant this person was given, never a path of its own choosing.
_grants: dict[str, dict] = {}


def normalize(raw) -> str | None:
    """An existing, absolute folder, normalised; None for anything else."""
    if not isinstance(raw, str) or not raw or len(raw) > MAX_PATH or re.search(r"[\x00-\x1f]", raw):
        return None
    if not os.path.isabs(raw):
        return None
    path = os.path.normpath(raw)
    return path if os.path.isdir(path) else None


def surface(session_id: str) -> str:
    return f"chat:{session_id}"


def choices(path: str) -> list[dict]:
    """Once, always and reject, each scope stated in words."""
    return [
        {"id": "once", "label": "Once, for this chat", "behavior": "allow", "scope": "session"},
        {"id": "forever", "label": f"Always allow reading {path}", "behavior": "allow", "scope": "forever"},
        {"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"},
    ]


def saved_decision(session_id: str, path: str):
    return permissions.stored_decision(surface(session_id), TOOL, path, True)


def remember(session_id: str, path: str, user: str) -> dict:
    grant_id = uuid.uuid4().hex
    _grants[grant_id] = {"session_id": session_id, "path": path, "user": user}
    return {"kind": "folder", "id": grant_id, "session_id": session_id,
            "label": os.path.basename(path.rstrip("\\/")) or path, "path": path}


def forget_session(session_id: str) -> None:
    """The chat ended: its "once" rules and its grants go with it."""
    permissions.drop_session(surface(session_id))
    for grant_id in [key for key, grant in _grants.items() if grant["session_id"] == session_id]:
        _grants.pop(grant_id, None)


def listing(path: str) -> tuple[list[str], bool]:
    """Relative names, folders first at each level, at most LISTING_LIMIT and
    LISTING_DEPTH deep. True as the second value when it was cut short."""
    names, pending = [], [("", 0)]
    while pending:
        relative, depth = pending.pop(0)
        try:
            with os.scandir(os.path.join(path, relative)) as entries:
                rows = sorted(entries, key=lambda entry: (not entry.is_dir(follow_symlinks=False), entry.name.lower()))
        except OSError:
            continue
        for entry in rows:
            name = os.path.join(relative, entry.name)
            folder = entry.is_dir(follow_symlinks=False)
            if len(names) >= LISTING_LIMIT:
                return names, True
            names.append(name + os.sep if folder else name)
            if folder and depth + 1 < LISTING_DEPTH:
                pending.append((name, depth + 1))
    return names, False


def reference_content(reference: dict, session_id: str, user: str | None) -> tuple[str, str]:
    """The path and a capped listing, for core/chat_references.py; raises
    ValueError when the grant is gone, belongs to someone else or another
    chat, or the broker no longer allows it."""
    grant = _grants.get(reference.get("id") or "")
    if (grant is None or grant["session_id"] != session_id or reference.get("session_id") not in (None, session_id)
            or grant["user"] != user):
        raise ValueError("A dropped folder is no longer available. Drop it on the notch again.")
    decision = saved_decision(session_id, grant["path"])
    if decision is None or decision.behavior != "allow" or not os.path.isdir(grant["path"]):
        raise ValueError("A dropped folder is no longer allowed. Drop it on the notch again to ask.")
    names, cut = listing(grant["path"])
    lines = [f"Folder: {grant['path']}",
             "The person dropped this folder on Kairos and allowed reading it. Below are names only, "
             "not contents; read a file with a file tool when the task needs it.",
             *names]
    if cut:
        lines.append(f"[Listing stops at {LISTING_LIMIT} names.]")
    return "dropped folder", "\n".join(lines)
