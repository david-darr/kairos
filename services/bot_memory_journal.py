"""The protected notebook journal (Bots Phase 2, unit U1; phase-2-design.md section 3.2).

Lives in `<DATA_DIR>/bot-memory-state/<bot_id>/`, outside every folder a model can write:

    journal.ndjson     one row per change (append-only)
    snapshots/<id>/N   the bytes each file had before the change, for Undo
    txn.json           the write-ahead manifest of a transaction in flight
    state.json         the last hash seen of every notebook file (to spot outside edits)
    shadow/<hash>      a copy of each current file, so an outside edit can be undone too

Rows hold id, time, actor, source, thread and run id, path, operation, before and after hashes,
counts and a redacted diff capped at 8,000 characters. Reads look at the last 8 MiB or 500 rows,
the API returns at most 200. Redaction happens before anything is written: a change whose original
bytes contained a hidden secret keeps no snapshot and is marked non-revertible, so a secret is never
kept as Undo material.
"""
import difflib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from core.logs import scrub_credentials
from services import bot_memory_store as store

DIFF_CAP = 8000
READ_BYTES = 8 * 1024 * 1024
READ_ROWS = 500
API_ROWS = 200
KEEP_SNAPSHOTS = 600


def redact(text: str) -> str:
    """Mask provider keys, tokens and `password = ...` style assignments before anything is stored or shown."""
    return scrub_credentials(text, "***")


def _dir(bot_id: str) -> Path:
    path = store.state_dir(bot_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex[:10]}.tmp")
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


# -- secrets and diffs --------------------------------------------------------------------------------------------
def has_secret(text: str) -> bool:
    return redact(text) != text


def make_diff(path: str, before: Optional[str], after: Optional[str]) -> str:
    """A unified diff of the redacted texts, capped; the cap never cuts the 'changed' meaning silently."""
    old = redact(before or "").splitlines(keepends=True)
    new = redact(after or "").splitlines(keepends=True)
    text = "".join(difflib.unified_diff(old, new, f"before/{path}" if before is not None else "/dev/null",
                                        f"after/{path}" if after is not None else "/dev/null", n=2))
    text = redact(text)
    return text if len(text) <= DIFF_CAP else text[:DIFF_CAP - 20].rstrip() + "\n... (diff cut)"


def counts(before: Optional[str], after: Optional[str]) -> dict:
    old = (before or "").splitlines()
    new = (after or "").splitlines()
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return {"added": added, "removed": removed, "bytes_before": len((before or "").encode("utf-8")),
            "bytes_after": len((after or "").encode("utf-8"))}


# -- the write-ahead manifest -------------------------------------------------------------------------------------
def write_manifest(bot_id: str, manifest: dict) -> None:
    _atomic(_dir(bot_id) / "txn.json", json.dumps(manifest, ensure_ascii=False).encode("utf-8"))


def read_manifest(bot_id: str) -> Optional[dict]:
    path = store.state_dir(bot_id) / "txn.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (ValueError, OSError):
        return {"id": "unreadable", "files": [], "broken": True}


def clear_manifest(bot_id: str) -> None:
    try:
        (store.state_dir(bot_id) / "txn.json").unlink()
    except FileNotFoundError:
        pass


# -- rows ---------------------------------------------------------------------------------------------------------
def append_row(bot_id: str, row: dict) -> None:
    path = _dir(bot_id) / "journal.ndjson"
    with open(path, "ab") as handle:
        handle.write((json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    _prune_snapshots(bot_id)


def _tail_rows(bot_id: str) -> list[dict]:
    path = store.state_dir(bot_id) / "journal.ndjson"
    try:
        size = path.stat().st_size
        with open(path, "rb") as handle:
            if size > READ_BYTES:
                handle.seek(size - READ_BYTES)
                handle.readline()   # a cut first line is dropped
            data = handle.read()
    except FileNotFoundError:
        return []
    rows = []
    for line in data.splitlines():
        try:
            row = json.loads(line.decode("utf-8"))
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("id"):
            rows.append(row)
    return rows[-READ_ROWS:]


def rows(bot_id: str, limit: int = API_ROWS) -> list[dict]:
    """Newest first, at most `limit` (200 at most). Each row says whether a later change reverted it."""
    window = _tail_rows(bot_id)
    reverted = {row["reverts"]: row["id"] for row in window if row.get("reverts")}
    out = []
    for row in reversed(window):
        item = dict(row)
        item["reverted_by"] = reverted.get(row["id"])
        out.append(item)
        if len(out) >= min(limit, API_ROWS):
            break
    return out


def find_row(bot_id: str, change_id: str) -> Optional[dict]:
    return next((row for row in rows(bot_id, API_ROWS) if row["id"] == change_id), None) or \
        next((dict(row, reverted_by=None) for row in reversed(_tail_rows(bot_id)) if row["id"] == change_id), None)


def has_row(bot_id: str, change_id: str) -> bool:
    return any(row["id"] == change_id for row in _tail_rows(bot_id))


# -- snapshots ----------------------------------------------------------------------------------------------------
def put_snapshot(bot_id: str, row_id: str, index: int, data: bytes) -> None:
    _atomic(_dir(bot_id) / "snapshots" / row_id / str(index), data)


def get_snapshot(bot_id: str, row_id: str, index: int) -> Optional[bytes]:
    try:
        return (store.state_dir(bot_id) / "snapshots" / row_id / str(index)).read_bytes()
    except FileNotFoundError:
        return None


def drop_snapshots(bot_id: str, row_id: str) -> None:
    shutil.rmtree(store.state_dir(bot_id) / "snapshots" / row_id, ignore_errors=True)


def _prune_snapshots(bot_id: str) -> None:
    root = store.state_dir(bot_id) / "snapshots"
    try:
        folders = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
    except FileNotFoundError:
        return
    for folder in folders[:max(0, len(folders) - KEEP_SNAPSHOTS)]:
        shutil.rmtree(folder, ignore_errors=True)


# -- what was last seen (outside-edit observation) ----------------------------------------------------------------
def read_seen(bot_id: str) -> Optional[dict]:
    """{path: hash} as last seen, or None when nothing has been seen yet."""
    try:
        data = json.loads((store.state_dir(bot_id) / "state.json").read_text(encoding="utf-8"))
        return data.get("files") if isinstance(data.get("files"), dict) else None
    except (FileNotFoundError, ValueError, OSError):
        return None


def write_seen(bot_id: str, files: dict) -> None:
    _atomic(_dir(bot_id) / "state.json", json.dumps({"files": files}).encode("utf-8"))


def put_shadow(bot_id: str, digest: str, data: bytes) -> None:
    target = _dir(bot_id) / "shadow" / digest
    if not target.exists():
        _atomic(target, data)


def get_shadow(bot_id: str, digest: str) -> Optional[bytes]:
    try:
        return (store.state_dir(bot_id) / "shadow" / digest).read_bytes()
    except FileNotFoundError:
        return None


def prune_shadow(bot_id: str, keep: set) -> None:
    root = store.state_dir(bot_id) / "shadow"
    try:
        for item in root.iterdir():
            if item.name not in keep:
                item.unlink(missing_ok=True)
    except FileNotFoundError:
        pass


def remove_bot_state(bot_id: str) -> None:
    shutil.rmtree(store.state_dir(bot_id), ignore_errors=True)
