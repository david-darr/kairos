"""Bounded profile audit tail. Lives beside SOUL.md, outside bot workspaces.

Callers hold AgentService's profile lock. Historical values are data and are
never replayed into a prompt without an explicit, revision-checked rollback.
"""
import json
import os
import time
import uuid
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 500
ACTORS = ("user", "bot", "file", "import", "system")


def path_for(service, agent_id):
    return Path(service._soul_path(agent_id)).with_name("profile-history.ndjson")


def rows(service, agent_id, limit=100, full=False):
    if type(limit) is not int or not 1 <= limit <= MAX_ROWS:
        raise ValueError("history limit is 1 to 500")
    path = path_for(service, agent_id)
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, os.SEEK_END)
            stream.seek(max(0, size - MAX_BYTES))
            if size > MAX_BYTES:
                stream.readline()
            lines = stream.readlines()
    except FileNotFoundError:
        lines = []
    found = []
    for line in lines:
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            continue  # an interrupted final append is not a historical change
        if not full and row.get("field") == "soul":
            row = {k: v for k, v in row.items() if k not in ("before", "after")}
        found.append(row)
    return found[-limit:][::-1]


def append(service, agent_id, before, after, revision, actor="user", receipt_id=None):
    if actor not in ACTORS:
        raise ValueError("unknown history actor")
    changes = []
    for key, value in after.items():
        if key in ("revision", "setup_receipts", "profile_proposals") or before.get(key) == value:
            continue
        changes.append({"id": uuid.uuid4().hex, "ts": time.time(), "actor": actor, "field": key,
                        "summary": f"Changed {key.replace('_', ' ')}", "before": before.get(key),
                        "after": value, "revision": revision, "receipt_id": receipt_id})
    if not changes:
        return
    path = path_for(service, agent_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    torn = path.exists() and path.stat().st_size > 0 and path.read_bytes()[-1:] != b"\n"
    with path.open("ab") as stream:
        if torn:
            stream.write(b"\n")  # an interrupted earlier append must not swallow this row
        for row in changes:
            stream.write((json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())
    # Retain only whole records, in append order. Bound disk as well as reads.
    if path.stat().st_size > MAX_BYTES or path.read_bytes().count(b"\n") > MAX_ROWS:
        kept, size = [], 0
        for row in rows(service, agent_id, MAX_ROWS, True):
            line = (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8")
            if size + len(line) > MAX_BYTES:
                break
            kept.append(line)
            size += len(line)
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(b"".join(reversed(kept)))
        os.replace(temporary, path)
