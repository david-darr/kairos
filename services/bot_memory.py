"""A bot's notebook (Bots Phase 2, unit U1; phase-2-design.md sections 3.1, 3.2 and 7).

The one place notebook files are read and changed. Everything else (the routes, the old memory
methods on agent_service, the tidy pass, and unit U2's capture, organize and dream jobs) calls the
functions below and never writes a notebook file itself.

    overview(bot_id)                      enabled state, index text and hash, capacity, files, maintenance
    read_file(bot_id, path)               one checked document with its hash
    apply_transaction(bot_id, changes, *, actor, source, ...)
                                          several files at once, each against its expected hash; one journal row
    apply_entry(bot_id, action, path, expected_hash, ...)
                                          append, replace, remove or supersede one note (archives what is displaced)
    begin_turn(bot_id, ...) / end_turn(bot_id, ...)
                                          credit outside edits to the person, journal the model's own file edits
    revert(bot_id, change_id)             guarded Undo of one journal row
    remove_bot(bot_id)                    delete the notebook and its protected state

A change is {"path", "expected_hash", and "content" (text) or "delete": True}. The expected hash is the
sha256 the caller read, or "absent" to create a file; a mismatch raises StaleState (409) and writes
nothing. Locks are per bot and never held across a model call. A transaction is written ahead
(manifest), applied, then journaled; after a crash the next access rolls it forward.
"""
import base64
import json
import logging
import threading
import time
from pathlib import Path
from typing import Optional

from services import bot_memory_entries as entries
from services import bot_memory_journal as journal
from services import bot_memory_store as store
from services.bot_memory_store import (ABSENT, ARCHIVE_PATH, INDEX_NAME, CapacityConflict, CapacityError, NotebookError,
                                       NotFound, PathRefused, StaleState)

log = logging.getLogger(__name__)

MAX_FILES_PER_TRANSACTION = 20
SHADOW_MAX_BYTES = store.WRITE_LIMIT_BYTES
_locks: dict = {}
_locks_guard = threading.Lock()
_migrated: set = set()

__all__ = ["overview", "read_file", "read_index_text", "prompt_index", "apply_transaction", "apply_entry", "write_text",
           "begin_turn", "end_turn", "revert", "remove_bot", "append_log", "list_topics", "remember", "migrate_all",
           "settings", "set_settings", "NotebookError", "StaleState", "CapacityError", "CapacityConflict", "NotFound",
           "PathRefused", "ABSENT"]


def lock(bot_id: str) -> threading.RLock:
    store.check_bot_id(bot_id)
    with _locks_guard:
        return _locks.setdefault(bot_id, threading.RLock())


def reset_caches() -> None:
    """For tests that simulate a restart."""
    _migrated.clear()


# =============================================================================================================
# Migration from the old memory files (agents/<id>/memory.md and friends)
# =============================================================================================================
def _legacy_dir(bot_id: str) -> Path:
    from services import agent_service
    return Path(agent_service.agents_dir()) / bot_id


def _migration_path(bot_id: str) -> Path:
    return store.state_dir(bot_id) / "migration.json"


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return None


def migration_state(bot_id: str) -> Optional[dict]:
    return _read_json(_migration_path(bot_id))


def _legacy_recover(directory: Path) -> None:
    """Finish an interrupted old-style tidy pass (agents/<id>/memory-upkeep.json) before its files are copied:
    the old rule rolled both files back to how they were before the pass."""
    path = directory / "memory-upkeep.json"
    data = _read_json(path)
    if not isinstance(data, dict):
        return
    pending = next((e for e in data.get("entries", []) if e.get("status") in ("pending", "undo-pending")), None)
    if not pending:
        return
    try:
        for item in pending["files"]:
            target = directory / item["name"]
            current = target.read_bytes() if target.exists() else None
            before = base64.b64decode(item["before"]) if item["before"] is not None else None
            after = base64.b64decode(item["after"]) if item["after"] is not None else None
            if current not in (before, after):
                return   # a person's edit during the pass: leave everything for the person to see
        for item in pending["files"]:
            target = directory / item["name"]
            keep = item["before"] if pending["status"] == "pending" else item["after"]
            if keep is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(keep))
    except (OSError, KeyError, ValueError):
        log.warning("memory migration: could not finish an interrupted tidy pass for %s", directory.name)


def _legacy_plan(directory: Path) -> list:
    """[(source name, destination path, bytes)] for every old memory file that exists."""
    plan = []
    index = directory / "memory.md"
    if index.is_file():
        plan.append(("memory.md", INDEX_NAME, index.read_bytes()))
    topics = directory / "memory"
    if topics.is_dir():
        for item in sorted(topics.glob("*.md")):
            if item.is_file() and store.TOPIC.fullmatch(item.stem):
                name = item.stem
                if name.lower() in store.RESERVED_TOPICS:
                    name += "_topic"
                plan.append((f"memory/{item.name}", f"memory/{name}.md", item.read_bytes()))
    archive = bytearray()
    sources = []
    main = directory / "memory-archive.md"
    if main.is_file():
        archive += main.read_bytes()
        sources.append("memory-archive.md")
    for item in sorted(directory.glob("memory-*-archive.md")):
        topic = item.name[len("memory-"):-len("-archive.md")]
        if item.is_file() and topic:
            archive += (b"" if archive.endswith(b"\n") or not archive else b"\n") + \
                f"\n## Archived topic notes: {topic}\n".encode("utf-8") + item.read_bytes()
            sources.append(item.name)
    if sources:
        plan.append((", ".join(sources), ARCHIVE_PATH, bytes(archive)))
    return plan


def _migrate(bot_id: str) -> None:
    done = migration_state(bot_id)
    if done and done.get("state") == "complete":
        return
    directory = _legacy_dir(bot_id)
    _legacy_recover(directory)
    plan = _legacy_plan(directory) if directory.is_dir() else []
    manifest = {"version": 1, "state": "in-progress", "started_at": time.time(),
                "sources": {source: {"sha256": store.sha256(data), "dest": dest} for source, dest, data in plan}}
    journal._atomic(_migration_path(bot_id).parent / "migration.json", json.dumps(manifest).encode("utf-8")) \
        if plan else None
    conflicts = []
    for source, dest, data in plan:
        current = store.read_bytes(bot_id, dest)
        if current is None:
            store.write_bytes(bot_id, dest, data)
        elif current != data:
            conflicts.append(dest)   # something is already there: it is kept, the old file stays as a backup
    for source, dest, data in plan:
        current = store.read_bytes(bot_id, dest)
        if current is None or (current != data and dest not in conflicts):
            raise NotebookError(f"memory migration could not verify {dest}")
    manifest.update(state="complete", completed_at=time.time(), kept_existing=conflicts)
    journal._atomic(_migration_path(bot_id), json.dumps(manifest).encode("utf-8"))


def migrate_all(bot_ids) -> None:
    for bot_id in bot_ids:
        try:
            with lock(bot_id):
                ensure_notebook(bot_id)
        except Exception:   # a bad folder for one bot must not stop the others, or the app
            log.exception("memory migration failed for bot %s", bot_id)


def ensure_notebook(bot_id: str) -> None:
    """Migrate once per process, finish any interrupted transaction, and take the first baseline of
    what is on disk (so a file already there is never mistaken for an outside edit)."""
    with lock(bot_id):
        _recover(bot_id)
        key = str(store.state_dir(bot_id))  # one per account: the same bot id can exist in two accounts
        if key not in _migrated:
            _migrate(bot_id)
            _migrated.add(key)
        if journal.read_seen(bot_id) is None:
            _baseline(bot_id)


# =============================================================================================================
# Reading
# =============================================================================================================
def _parse_front(text: str) -> dict:
    """title, description and aliases of a topic: a frontmatter block, or the old first line 'Description: ...'."""
    meta = {"title": "", "description": "", "aliases": []}
    if text.startswith("---"):
        head = text.split("\n", 40)
        if head and head[0].strip() == "---":
            for line in head[1:]:
                if line.strip() == "---":
                    break
                key, _, value = line.partition(":")
                key, value = key.strip().lower(), value.strip()
                if key in ("title", "description"):
                    meta[key] = value[:200]
                elif key == "aliases":
                    items = [part.strip().strip("'\"") for part in value.strip("[]").split(",")]
                    meta["aliases"] = [item for item in items if item][:10]
            return meta
    first = text.split("\n", 1)[0].strip() if text else ""
    if first.startswith("Description: "):
        meta["description"] = " ".join(first[len("Description: "):].split())[:200]
    return meta


def topic_text(topic: str, description: str = "", title: str = "", aliases=()) -> str:
    rows = ["---", f"title: {' '.join((title or topic).split())[:120]}",
            f"description: {' '.join((description or '').split())[:200]}"]
    if aliases:
        rows.append("aliases: [" + ", ".join(" ".join(str(a).split())[:40] for a in list(aliases)[:10]) + "]")
    return "\n".join(rows + ["---", ""])


def _file_info(path: str, data: bytes) -> dict:
    target = store.classify(path)
    info = {"path": path, "kind": target.kind, "bytes": len(data), "hash": store.sha256(data),
            "lines": data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0),
            "read_only": target.kind == store.KIND_LOG, "limit": target.limit}
    if target.kind == store.KIND_TOPIC:
        name = path[len("memory/"):-3]
        try:
            meta = _parse_front(data[:2048].decode("utf-8", errors="ignore"))
        except Exception:
            meta = {"title": "", "description": "", "aliases": []}
        info.update(name=name, title=meta["title"] or name, description=meta["description"] or "No description provided",
                    aliases=meta["aliases"])
    return info


def read_file(bot_id: str, path: str, *, missing_ok: bool = False) -> dict:
    ensure_notebook(bot_id)
    data = store.read_bytes(bot_id, path)
    if data is None:
        if missing_ok:
            target = store.classify(path)
            return {"path": path, "kind": target.kind, "text": "", "hash": ABSENT, "exists": False, "bytes": 0,
                    "lines": 0, "read_only": target.kind == store.KIND_LOG, "limit": target.limit}
        raise NotFound("there is no such note")
    info = _file_info(path, data)
    info.update(text=store.decode(data), exists=True)
    if info["kind"] in (store.KIND_INDEX, store.KIND_TOPIC):
        info["notes"] = notes_of(info["text"])
    return info


def notes_of(text: str, limit: int = 500) -> list[dict]:
    """The notes in a document as the editor lists them (its Simple page adds and removes by `id`)."""
    out = []
    for entry in entries.parse(text).entries[:limit]:
        out.append({"id": entry.eid, "section": entry.section, "text": entry.text, "source": entry.source,
                    "learned": entry.learned.isoformat(), "until": entry.until.isoformat() if entry.until else None,
                    "superseded": entry.superseded.isoformat() if entry.superseded else None,
                    "protected": entry.protected(), "legacy": entry.legacy})
    return out


def read_index_text(bot_id: str) -> str:
    ensure_notebook(bot_id)
    return store.decode(store.read_bytes(bot_id, INDEX_NAME))


def prompt_index(bot_id: str) -> tuple[str, dict]:
    """What a turn loads of the index, with the loaded-versus-stored report."""
    return store.clip_index(read_index_text(bot_id))


def list_topics(bot_id: str) -> list[dict]:
    ensure_notebook(bot_id)
    topics = []
    for path in store.list_files(bot_id):
        if store.classify(path).kind != store.KIND_TOPIC:
            continue
        try:
            with open(store.locate(bot_id, path)[1], "rb") as handle:
                head = handle.read(2048)
            size = store.locate(bot_id, path)[1].stat().st_size
        except OSError:
            continue
        name = path[len("memory/"):-3]
        meta = _parse_front(head.decode("utf-8", errors="ignore"))
        topics.append({"name": name, "path": path, "title": meta["title"] or name, "bytes": size,
                       "description": meta["description"] or "No description provided", "aliases": meta["aliases"]})
    return topics


def settings(bot_id: str) -> dict:
    """The notebook preferences. `memory_enabled` and `memory_upkeep` are fields of the bot record
    (unit U4 owns the field list); room capture is kept here until the resource settings land."""
    from services.agent_service import agent_service
    agent = agent_service.get(bot_id) or {}
    stored = _read_json(store.state_dir(bot_id) / "settings.json") or {}
    enabled = agent["memory_enabled"] if "memory_enabled" in agent else bool(stored.get("memory_enabled", True))
    return {"enabled": bool(enabled), "upkeep": bool(agent.get("memory_upkeep")),
            "room_capture": bool(stored.get("room_capture", False))}


def set_settings(bot_id: str, *, enabled=None, upkeep=None, room_capture=None) -> dict:
    from services.agent_service import EDITABLE, agent_service
    for value in (enabled, upkeep, room_capture):
        if value is not None and not isinstance(value, bool):
            raise NotebookError("settings are on or off")
    changes = {}
    stored = _read_json(store.state_dir(bot_id) / "settings.json") or {}
    if enabled is not None:
        if "memory_enabled" in EDITABLE:
            changes["memory_enabled"] = enabled
        else:
            stored["memory_enabled"] = enabled
    if upkeep is not None:
        changes["memory_upkeep"] = upkeep
    if room_capture is not None:
        stored["room_capture"] = room_capture
    if enabled is not None or room_capture is not None:
        with lock(bot_id):
            journal._atomic(journal._dir(bot_id) / "settings.json", json.dumps(stored).encode("utf-8"))
    if changes:
        agent_service.update(bot_id, **changes)
    return settings(bot_id)


def overview(bot_id: str) -> dict:
    ensure_notebook(bot_id)
    from services.agent_service import agent_service
    with lock(bot_id):
        files = []
        for path in store.list_files(bot_id):
            kind = store.classify(path).kind
            if kind in (store.KIND_SKILL, store.KIND_REFERENCE):
                continue
            data = store.read_bytes(bot_id, path)
            if data is not None:
                info = _file_info(path, data)
                try:
                    info["modified"] = store.locate(bot_id, path)[1].stat().st_mtime
                except OSError:
                    info["modified"] = None
                files.append(info)
        data = store.read_bytes(bot_id, INDEX_NAME)
        text = store.decode(data)
        clipped, capacity = store.clip_index(text)
    latest = journal.rows(bot_id, 50)
    last_tidy = next((r for r in latest if r.get("actor") in ("upkeep", "dream", "capture", "organize") and not r.get("reverted_by")), None)
    agent = agent_service.get(bot_id) or {}
    conversation = agent.get("name") or ""
    return {"bot_id": bot_id, "bot_name": conversation, "settings": settings(bot_id),
            "enabled": settings(bot_id)["enabled"],
            "index": {"path": INDEX_NAME, "text": text, "hash": store.sha256(data), "exists": data is not None, **capacity,
                      "notes": notes_of(text)},
            "files": files,
            "maintenance": {"upkeep": bool(agent.get("memory_upkeep")), "changes": len(latest),
                            "last": ({"id": last_tidy["id"], "time": last_tidy["time"], "actor": last_tidy["actor"],
                                      "summary": last_tidy.get("summary", "")} if last_tidy else None)}}


# =============================================================================================================
# Transactions
# =============================================================================================================
def _check_hash(value, path) -> str:
    if value == ABSENT or (isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)):
        return value
    raise NotebookError(f"{path}: say what version you read (its hash), or 'absent' to create it")


def _clean_changes(bot_id: str, changes) -> list:
    if not isinstance(changes, (list, tuple)) or not changes:
        raise NotebookError("there is nothing to change")
    if len(changes) > MAX_FILES_PER_TRANSACTION:
        raise NotebookError(f"at most {MAX_FILES_PER_TRANSACTION} files can change at once")
    out, seen = [], set()
    for change in changes:
        path = change.get("path")
        target, full = store.locate(bot_id, path)
        if target.path in seen:
            raise NotebookError(f"{path} appears twice in one change")
        seen.add(target.path)
        store.check_case(full)
        # A caller may say `None` for "this file must not exist yet", and may call the text `text`.
        expected = _check_hash(ABSENT if "expected_hash" in change and change["expected_hash"] is None else change.get("expected_hash"), path)
        if change.get("delete"):
            out.append({"path": target.path, "target": target, "expected": expected, "after": None})
            continue
        if "data" in change and isinstance(change["data"], (bytes, bytearray)):
            after = bytes(change["data"])
        else:
            content = change["content"] if "content" in change else change.get("text")
            if not isinstance(content, str):
                raise NotebookError(f"{path} needs text")
            after = content.encode("utf-8")
        if len(after) > target.limit:
            raise CapacityError(f"{path} is limited to {target.limit // 1024} KiB; this is {len(after) // 1024 + 1} KiB")
        out.append({"path": target.path, "target": target, "expected": expected, "after": after})
    return out


def _text_of(data: Optional[bytes]) -> Optional[str]:
    return None if data is None else data.decode("utf-8", errors="replace").replace("\r\n", "\n")


def apply_transaction(bot_id: str, changes, *, actor: str, source: str, thread_id: Optional[str] = None,
                      run_id: Optional[str] = None, summary: Optional[str] = None, operation: Optional[str] = None,
                      reverts: Optional[str] = None, now: Optional[float] = None,
                      extra: Optional[dict] = None) -> dict:
    """Change several notebook files at once. Every file is checked against the hash the caller read; if any
    differs nothing is written (StaleState). Returns {"changed", "row", "hashes"}; an all-unchanged request
    writes and journals nothing."""
    store.check_bot_id(bot_id)
    with lock(bot_id):
        ensure_notebook(bot_id)
        planned = _clean_changes(bot_id, changes)
        stale, files, work = {}, [], []
        for item in planned:
            before = store.read_bytes(bot_id, item["path"])
            current = store.sha256(before)
            if current != item["expected"]:
                stale[item["path"]] = current
                continue
            if item["after"] is None and before is None:
                raise NotFound(f"{item['path']} is not there")
            if item["after"] is None and item["target"].kind == store.KIND_INDEX and operation != "revert":
                raise NotebookError("the notebook's main page cannot be deleted; empty it instead")
            if item["after"] == before or (before is not None and item["after"] == before.replace(b"\r\n", b"\n")):
                continue   # nothing changed (a file's CRLF line ends alone are not a change)
            work.append((item, before))
        if stale:
            raise StaleState("this note changed since you opened it; reload it first", stale)
        if not work:
            return {"changed": False, "row": None, "hashes": {i["path"]: i["expected"] for i in planned}}
        row_id = journal.new_id()
        revertible = True
        manifest_files = []
        for index, (item, before) in enumerate(work):
            before_text, after_text = _text_of(before), _text_of(item["after"])
            secret = bool(before_text) and journal.has_secret(before_text)
            keep_snapshot = before is not None and not secret
            if before is not None and secret:
                revertible = False
            op = "create" if before is None else "delete" if item["after"] is None else "edit"
            if operation == "revert":
                op = "revert"
            files.append({"path": item["path"], "operation": op, "before_hash": store.sha256(before),
                          "after_hash": store.sha256(item["after"]), "counts": journal.counts(before_text, after_text),
                          "diff": journal.make_diff(item["path"], before_text, after_text), "snapshot": index if keep_snapshot else None})
            manifest_files.append({"path": item["path"], "before_hash": store.sha256(before),
                                   "after_hash": store.sha256(item["after"]),
                                   "after_b64": None if item["after"] is None else base64.b64encode(item["after"]).decode("ascii")})
            if keep_snapshot:
                journal.put_snapshot(bot_id, row_id, index, before)
        # Cap the rows' diff text as a whole: the first files keep theirs, later ones are shortened.
        budget = journal.DIFF_CAP
        for file in files:
            file["diff"] = file["diff"][:budget]
            budget = max(0, budget - len(file["diff"]))
        first = files[0]
        row = {"id": row_id, "time": time.time() if now is None else now, "actor": actor, "source": source,
               "thread_id": thread_id, "run_id": run_id, "path": first["path"] if len(files) == 1 else f"{len(files)} files",
               "operation": operation or first["operation"], "before_hash": first["before_hash"],
               "after_hash": first["after_hash"], "files": files, "revertible": revertible, "reverts": reverts,
               "counts": {"files": len(files), "added": sum(f["counts"]["added"] for f in files),
                          "removed": sum(f["counts"]["removed"] for f in files)},
               "diff": "\n".join(f["diff"] for f in files if f["diff"])[:journal.DIFF_CAP],
               "summary": summary or _summary(files)}
        for key, value in (extra or {}).items():
            row.setdefault(key, value)   # extra detail (a tidy pass's changes); never overrides a core field
        journal.write_manifest(bot_id, {"id": row_id, "files": manifest_files, "row": row})
        try:
            for item, _ in work:
                if item["after"] is None:
                    store.remove_file(bot_id, item["path"])
                else:
                    store.write_bytes(bot_id, item["path"], item["after"])
            journal.append_row(bot_id, row)
        except Exception:
            # A failure the process survived (a full disk, a locked file) undoes the whole change: every file goes
            # back to what it was. Only if that fails too is the manifest kept, so the next access finishes it.
            if _roll_back(bot_id, work):
                journal.clear_manifest(bot_id)
                journal.drop_snapshots(bot_id, row_id)
            raise
        journal.clear_manifest(bot_id)
        _remember_seen(bot_id, {i["path"]: i["after"] for i, _ in work})
        return {"changed": True, "row": row, "hashes": {i["path"]: store.sha256(i["after"]) for i, _ in work}}


def _roll_back(bot_id: str, work: list) -> bool:
    ok = True
    for item, before in work:
        try:
            if store.sha256(store.read_bytes(bot_id, item["path"])) == store.sha256(before):
                continue
            if before is None:
                store.remove_file(bot_id, item["path"])
            else:
                store.write_bytes(bot_id, item["path"], before)
        except Exception:
            log.exception("memory: could not roll back %s", item["path"])
            ok = False
    return ok


def _summary(files: list) -> str:
    if len(files) == 1:
        file = files[0]
        verb = {"create": "Created", "delete": "Deleted", "edit": "Edited", "revert": "Undid a change to"}[file["operation"]]
        return f"{verb} {file['path']}"
    return f"Changed {len(files)} notes"


def write_text(bot_id: str, path: str, text: str, expected_hash: str, *, actor: str, source: str, **extra) -> dict:
    """One file, whole text. The convenience over apply_transaction that the routes and adapters use."""
    return apply_transaction(bot_id, [{"path": path, "expected_hash": expected_hash, "content": text}],
                             actor=actor, source=source, **extra)


def delete_file(bot_id: str, path: str, expected_hash: str, *, actor: str, source: str, **extra) -> dict:
    return apply_transaction(bot_id, [{"path": path, "expected_hash": expected_hash, "delete": True}],
                             actor=actor, source=source, **extra)


def _fits_for(kind: str):
    if kind == store.KIND_INDEX:
        return lambda text: not store.over_load_limits(text)
    return lambda text: len(text.encode("utf-8")) <= store.TOPIC_LIMIT_BYTES


def apply_entry(bot_id: str, action: str, path: str, expected_hash: str, *, section: Optional[str] = None,
                body: Optional[str] = None, source: str = "owner", until=None, target: Optional[str] = None,
                actor: str = "person", thread_id: Optional[str] = None, run_id: Optional[str] = None,
                now: Optional[float] = None, description: Optional[str] = None) -> dict:
    """One note action on an index or topic document, checked against the hash read. Notes that make-room
    displaces go to memory/archive.md in the same transaction (an oversized archive is a 413, nothing written)."""
    with lock(bot_id):
        ensure_notebook(bot_id)
        info = store.classify(path)
        if info.kind not in (store.KIND_INDEX, store.KIND_TOPIC):
            raise NotebookError("notes are added to the main page or a topic")
        before = store.read_bytes(bot_id, path)
        if store.sha256(before) != _check_hash(expected_hash, path):
            raise StaleState("this note changed since you opened it; reload it first", {path: store.sha256(before)})
        text = store.decode(before)
        if before is None and info.kind == store.KIND_TOPIC:
            name = path[len("memory/"):-3]
            text = topic_text(name, description or "")
        today = entries.local_today(now)
        new_text, displaced, summary = entries.apply_action(text, action, fits=_fits_for(info.kind), today=today, section=section,
                                                            body=body, source=source, until=until, target=target)
        changes = [{"path": path, "expected_hash": store.sha256(before), "content": new_text}]
        if displaced:
            archive = store.read_bytes(bot_id, ARCHIVE_PATH)
            archived = (store.decode(archive) + entries.archive_block(displaced, today))
            changes.append({"path": ARCHIVE_PATH, "expected_hash": store.sha256(archive), "content": archived})
            summary += f"; moved {len(displaced)} older to the archive"
        result = apply_transaction(bot_id, changes, actor=actor, source=source, thread_id=thread_id, run_id=run_id,
                                   summary=summary, now=now)
        result["text"] = new_text
        result["displaced"] = len(displaced)
        return result


def remember(bot_id: str, section: str, text: str, *, until=None, topic: Optional[str] = None,
             description: Optional[str] = None, source: str = "agent", actor: str = "bot",
             thread_id: Optional[str] = None, run_id: Optional[str] = None, now: Optional[float] = None) -> str:
    """Add a dated note, archiving what must go to make room. The legacy `remember` placement on the new
    grammar; returns the document text. Errors are ValueErrors with plain messages."""
    with lock(bot_id):
        path = store.topic_path(topic) if topic is not None else INDEX_NAME
        ensure_notebook(bot_id)
        before = store.read_bytes(bot_id, path)
        return apply_entry(bot_id, "append", path, store.sha256(before), section=section, body=text, source=source,
                           until=until, actor=actor, thread_id=thread_id, run_id=run_id, now=now,
                           description=description)["text"]


def append_log(bot_id: str, day: str, line: str, run_id: str, *, actor: str = "system", source: str = "maintenance") -> bool:
    """One redacted outcome line in the day's log, once per run id. Returns False when it was already there."""
    redact = journal.redact
    path = store.classify(f"memory/log/{day}.md").path
    with lock(bot_id):
        ensure_notebook(bot_id)
        before = store.read_bytes(bot_id, path)
        text = store.decode(before)
        marker = f"[run {run_id}]"
        if marker in text:
            return False
        clean = " ".join(redact(line).split())[:500]
        text = (text if text else f"# {day}\n\n") + f"- {time.strftime('%H:%M')} {marker} {clean}\n"
        write_text(bot_id, path, text, store.sha256(before), actor=actor, source=source, run_id=run_id)
        return True


# =============================================================================================================
# Outside edits: begin_turn and end_turn
# =============================================================================================================
def _scan(bot_id: str) -> dict:
    found = {}
    for path in store.list_files(bot_id):
        try:
            data = store.read_bytes(bot_id, path)
        except NotebookError:
            continue
        if data is not None:
            found[path] = data
    return found


def _remember_seen(bot_id: str, changed: dict) -> None:
    """After our own change, take its result as the new baseline for those files."""
    seen = journal.read_seen(bot_id)
    if seen is None:
        seen = {}
    for path, data in changed.items():
        if data is None:
            seen.pop(path, None)
        else:
            seen[path] = store.sha256(data)
            _shadow(bot_id, data)
    journal.write_seen(bot_id, seen)
    journal.prune_shadow(bot_id, set(seen.values()))


def _shadow(bot_id: str, data: bytes) -> None:
    if len(data) <= SHADOW_MAX_BYTES:
        text = data.decode("utf-8", errors="replace")
        if not journal.has_secret(text):
            journal.put_shadow(bot_id, store.sha256(data), data)


def _baseline(bot_id: str) -> None:
    current = _scan(bot_id)
    journal.write_seen(bot_id, {path: store.sha256(data) for path, data in current.items()})
    for data in current.values():
        _shadow(bot_id, data)
    journal.prune_shadow(bot_id, {store.sha256(data) for data in current.values()})


def _observe(bot_id: str, *, actor: str, source: str, thread_id: Optional[str], run_id: Optional[str]) -> Optional[dict]:
    """Journal whatever differs between the files and the last baseline, as one row."""
    seen = journal.read_seen(bot_id)
    current = _scan(bot_id)
    if seen is None:
        _baseline(bot_id)
        return None
    files, revertible, row_id = [], True, journal.new_id()
    for path in sorted(set(seen) | set(current)):
        before_hash = seen.get(path, ABSENT)
        data = current.get(path)
        after_hash = store.sha256(data)
        if before_hash == after_hash:
            continue
        before = None if before_hash == ABSENT else journal.get_shadow(bot_id, before_hash)
        if before_hash != ABSENT and before is None:
            revertible = False
        before_text, after_text = _text_of(before), _text_of(data)
        snapshot = None
        if before is not None:
            snapshot = len(files)
            journal.put_snapshot(bot_id, row_id, snapshot, before)
        op = "create" if before_hash == ABSENT else "delete" if data is None else "edit"
        files.append({"path": path, "operation": op, "before_hash": before_hash, "after_hash": after_hash,
                      "counts": journal.counts(before_text, after_text) if before_hash == ABSENT or before is not None
                      else {"added": 0, "removed": 0, "bytes_before": 0, "bytes_after": len(data or b"")},
                      "diff": journal.make_diff(path, before_text, after_text) if (before is not None or before_hash == ABSENT) else "",
                      "snapshot": snapshot})
    if not files:
        return None
    budget = journal.DIFF_CAP
    for file in files:
        file["diff"] = file["diff"][:budget]
        budget = max(0, budget - len(file["diff"]))
    row = {"id": row_id, "time": time.time(), "actor": actor, "source": source, "thread_id": thread_id, "run_id": run_id,
           "path": files[0]["path"] if len(files) == 1 else f"{len(files)} files", "operation": "external-edit",
           "before_hash": files[0]["before_hash"], "after_hash": files[0]["after_hash"], "files": files,
           "revertible": revertible, "reverts": None,
           "counts": {"files": len(files), "added": sum(f["counts"]["added"] for f in files),
                      "removed": sum(f["counts"]["removed"] for f in files)},
           "diff": "\n".join(f["diff"] for f in files if f["diff"])[:journal.DIFF_CAP],
           "summary": f"{'You' if actor == 'person' else 'The bot'} changed {files[0]['path'] if len(files) == 1 else str(len(files)) + ' notes'}"}
    journal.append_row(bot_id, row)
    journal.write_seen(bot_id, {path: store.sha256(data) for path, data in current.items()})
    for data in current.values():
        _shadow(bot_id, data)
    journal.prune_shadow(bot_id, {store.sha256(data) for data in current.values()})
    return row


def begin_turn(bot_id: str, thread_id: Optional[str] = None, run_id: Optional[str] = None) -> dict:
    """Start of a turn: edits made outside Kairos since the last look are credited to the person."""
    with lock(bot_id):
        ensure_notebook(bot_id)
        row = _observe(bot_id, actor="person", source="edit outside Kairos", thread_id=thread_id, run_id=run_id)
    return {"turn": journal.new_id(), "observed": row["id"] if row else None}


def end_turn(bot_id: str, thread_id=None, run_id: Optional[str] = None, status: str = "done",
             turn: Optional[dict] = None) -> Optional[dict]:
    """End of a turn, including after a cancel or a failure: file edits the model made directly are journaled.
    The second argument is the thread id (a begin_turn result passed there is accepted and ignored)."""
    if isinstance(thread_id, dict):
        thread_id = None
    with lock(bot_id):
        ensure_notebook(bot_id)
        return _observe(bot_id, actor="bot", source=f"model file edit ({status})" if status != "done" else "model file edit",
                        thread_id=thread_id, run_id=run_id)


# =============================================================================================================
# Crash recovery and Undo
# =============================================================================================================
def _recover(bot_id: str) -> None:
    manifest = journal.read_manifest(bot_id)
    if manifest is None:
        return
    if manifest.get("broken") or not isinstance(manifest.get("files"), list):
        journal.clear_manifest(bot_id)
        return
    conflicts = []
    for item in manifest["files"]:
        current = store.sha256(store.read_bytes(bot_id, item["path"]))
        if current == item["after_hash"]:
            continue
        if current == item["before_hash"]:
            if item["after_b64"] is None:
                store.remove_file(bot_id, item["path"])
            else:
                store.write_bytes(bot_id, item["path"], base64.b64decode(item["after_b64"]))
        else:
            conflicts.append(item["path"])
    row = manifest.get("row")
    if isinstance(row, dict) and not journal.has_row(bot_id, row.get("id", "")):
        if conflicts:
            row = dict(row, revertible=False, recovery_conflicts=conflicts)
        journal.append_row(bot_id, row)
    journal.clear_manifest(bot_id)
    journal.write_seen(bot_id, {p: store.sha256(d) for p, d in _scan(bot_id).items()})


def revert(bot_id: str, change_id: str, *, actor: str = "person", source: str = "undo",
           thread_id: Optional[str] = None) -> dict:
    """Undo one journal row, only if every file it touched is still exactly as the change left it (409 if not).
    All files go back together or none does; undoing twice is refused."""
    with lock(bot_id):
        ensure_notebook(bot_id)
        row = journal.find_row(bot_id, change_id)
        if row is None:
            raise NotFound("there is no such change")
        if row.get("reverted_by"):
            raise StaleState("this change was already undone")
        if not row.get("revertible", False):
            raise StaleState("this change cannot be undone: it held text that was hidden, so no copy of the old version is kept")
        changes, stale = [], {}
        for file in row["files"]:
            current = store.sha256(store.read_bytes(bot_id, file["path"]))
            if current != file["after_hash"]:
                stale[file["path"]] = current
                continue
            if file["before_hash"] == ABSENT:
                changes.append({"path": file["path"], "expected_hash": file["after_hash"], "delete": True})
                continue
            snapshot = journal.get_snapshot(bot_id, change_id, file["snapshot"]) if file.get("snapshot") is not None else None
            if snapshot is None or store.sha256(snapshot) != file["before_hash"]:
                raise StaleState("this change cannot be undone: its old version is no longer kept")
            changes.append({"path": file["path"], "expected_hash": file["after_hash"], "data": snapshot})
        if stale:
            raise StaleState("this change cannot be undone: the notes changed after it", stale)
        result = apply_transaction(bot_id, changes, actor=actor, source=source, thread_id=thread_id, operation="revert",
                                   reverts=change_id, summary=f"Undid: {row.get('summary', 'a change')}")
        return result


def remove_bot(bot_id: str) -> None:
    """The notebook and its protected state go with the bot. Shared library skills and saved logins never do."""
    import shutil
    with lock(bot_id):
        root = store.workspace(bot_id)
        if root.exists() and not store.is_reparse(root):
            shutil.rmtree(root, ignore_errors=True)
        journal.remove_bot_state(bot_id)
        _migrated.discard(str(store.state_dir(bot_id)))
