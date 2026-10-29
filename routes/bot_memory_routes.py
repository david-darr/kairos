"""A bot's notebook over HTTP (Bots Phase 2, unit U1; phase-2-design.md section 5).

Mounted by routes/bot_resources_routes.py beneath /api/bots. Admin only, like every Bots route. All
logic is in services/bot_memory.py; these routes check input, map its refusals to the standard codes
(400 invalid, 403 denied, 404 missing, 409 stale, 413 capacity) and keep a path a notebook shape, never
a filesystem path. File and entry changes carry the hash the client read (`expected_hash`; "absent" to
create), so an edit made elsewhere is a 409 and never a silent overwrite.
"""
import ipaddress
import os
import subprocess
import sys
import urllib.parse
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from core.middleware import require_admin
from services import bot_memory, bot_memory_journal, bot_memory_store as store
from services.agent_service import agent_service

router = APIRouter(prefix="/api/bots", tags=["bot-memory"])

EDITABLE_KINDS = (store.KIND_INDEX, store.KIND_TOPIC, store.KIND_ARCHIVE)
READABLE_KINDS = (*EDITABLE_KINDS, store.KIND_LOG)
JOURNAL_DEFAULT = 50


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: Optional[StrictBool] = None
    upkeep: Optional[StrictBool] = None
    room_capture: Optional[StrictBool] = None


class FileBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=store.WRITE_LIMIT_BYTES)
    expected_hash: str = Field(max_length=64)


class EntryBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(max_length=20)
    path: str = Field(default=store.INDEX_NAME, max_length=200)
    expected_hash: str = Field(max_length=64)
    section: Optional[str] = Field(default=None, max_length=60)
    text: Optional[str] = Field(default=None, max_length=1200)
    until: Optional[str] = Field(default=None, max_length=10)
    target: Optional[str] = Field(default=None, max_length=40)
    description: Optional[str] = Field(default=None, max_length=200)


class OpenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: str = Field(default="folder", max_length=20)


def _bot(bot_id: str) -> dict:
    agent = agent_service.get(bot_id) if isinstance(bot_id, str) else None
    if agent is None:
        raise HTTPException(status_code=404, detail="no such bot")
    return agent


def _fail(error: Exception) -> HTTPException:
    if isinstance(error, store.NotebookError):
        return HTTPException(status_code=error.status, detail=str(error))
    return HTTPException(status_code=400, detail=str(error))


def _kind(path: str, allowed=READABLE_KINDS) -> str:
    try:
        target = store.classify(path)
    except store.NotebookError as error:
        raise _fail(error)
    if target.kind in allowed:
        return target.kind
    if target.kind == store.KIND_LOG and allowed is EDITABLE_KINDS:
        raise HTTPException(status_code=403, detail="daily logs are read-only")
    raise HTTPException(status_code=400, detail="that is not a note")


def _row(row: dict) -> dict:
    """A journal row as the editor draws it (no internal snapshot numbers)."""
    out = {key: row.get(key) for key in ("id", "time", "actor", "source", "thread_id", "run_id", "path", "operation",
                                        "before_hash", "after_hash", "counts", "diff", "summary", "revertible", "reverts",
                                        "reverted_by")}
    out["files"] = [{key: file.get(key) for key in ("path", "operation", "before_hash", "after_hash", "counts")}
                    for file in row.get("files", [])]
    return out


@router.get("/{bot_id}/memory")
async def memory_overview(bot_id: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        return await run_in_threadpool(bot_memory.overview, bot_id)
    except store.NotebookError as error:
        raise _fail(error)


@router.patch("/{bot_id}/memory/settings")
async def memory_settings(bot_id: str, body: SettingsBody, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        return await run_in_threadpool(lambda: bot_memory.set_settings(
            bot_id, enabled=body.enabled, upkeep=body.upkeep, room_capture=body.room_capture))
    except (store.NotebookError, ValueError) as error:
        raise _fail(error)


@router.get("/{bot_id}/memory/file")
async def memory_file_read(bot_id: str, path: str = Query(max_length=200), user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    _kind(path)
    try:
        return await run_in_threadpool(bot_memory.read_file, bot_id, path)
    except store.NotebookError as error:
        raise _fail(error)


@router.put("/{bot_id}/memory/file")
async def memory_file_write(bot_id: str, body: FileBody, path: str = Query(max_length=200),
                            user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    _kind(path, EDITABLE_KINDS)
    try:
        result = await run_in_threadpool(lambda: bot_memory.write_text(
            bot_id, path, body.text, body.expected_hash, actor="person", source="memory editor"))
        info = await run_in_threadpool(bot_memory.read_file, bot_id, path)
    except store.NotebookError as error:
        raise _fail(error)
    return {"file": info, "changed": result["changed"], "change_id": result["row"]["id"] if result["row"] else None}


@router.delete("/{bot_id}/memory/file")
async def memory_file_delete(bot_id: str, path: str = Query(max_length=200), expected_hash: str = Query(max_length=64),
                             user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    kind = _kind(path, EDITABLE_KINDS)
    if kind == store.KIND_INDEX:
        raise HTTPException(status_code=403, detail="the notebook's main page cannot be deleted; empty it instead")
    try:
        result = await run_in_threadpool(lambda: bot_memory.delete_file(
            bot_id, path, expected_hash, actor="person", source="memory editor"))
    except store.NotebookError as error:
        raise _fail(error)
    return {"deleted": True, "change_id": result["row"]["id"] if result["row"] else None}


@router.post("/{bot_id}/memory/entries")
async def memory_entry(bot_id: str, body: EntryBody, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    _kind(body.path, (store.KIND_INDEX, store.KIND_TOPIC))
    try:
        result = await run_in_threadpool(lambda: bot_memory.apply_entry(
            bot_id, body.action, body.path, body.expected_hash, section=body.section, body=body.text, source="owner",
            until=body.until, target=body.target, actor="person", description=body.description))
        info = await run_in_threadpool(bot_memory.read_file, bot_id, body.path)
    except store.NotebookError as error:
        raise _fail(error)
    return {"file": info, "changed": result["changed"], "displaced": result["displaced"],
            "change_id": result["row"]["id"] if result["row"] else None}


@router.get("/{bot_id}/memory/journal")
async def memory_journal(bot_id: str, limit: int = Query(default=JOURNAL_DEFAULT, ge=1, le=bot_memory_journal.API_ROWS),
                         user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        await run_in_threadpool(bot_memory.ensure_notebook, bot_id)
    except store.NotebookError as error:
        raise _fail(error)
    return {"rows": [_row(row) for row in bot_memory_journal.rows(bot_id, limit)]}


@router.post("/{bot_id}/memory/journal/{change}/revert")
async def memory_revert(bot_id: str, change: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    if not store.BOT_ID.fullmatch(bot_id) or not change.isalnum() or len(change) > 32:
        raise HTTPException(status_code=404, detail="there is no such change")
    try:
        result = await run_in_threadpool(lambda: bot_memory.revert(bot_id, change, actor="person", source="undo"))
    except store.NotebookError as error:
        raise _fail(error)
    return {"reverted": change, "change_id": result["row"]["id"] if result["row"] else None}


@router.get("/{bot_id}/memory/upkeep")
async def memory_upkeep(bot_id: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    entries = await run_in_threadpool(agent_service.memory_upkeep_journal, bot_id)
    return {"enabled": bool(agent_service.get(bot_id).get("memory_upkeep")), "entries": entries}


# Unit U2 replaces this with its queued model-assisted tidy; both are one callable taking a bot id.
def _tidy_now(bot_id: str) -> dict:
    from services import agent_memory_upkeep
    done = []
    for topic in [None, *[name for name, _ in agent_service.topic_index(bot_id)]]:
        result = agent_memory_upkeep.upkeep(agent_service, bot_id, topic=topic, force=True)
        if result:
            done.append(result["id"])
    return {"passes": done}


tidy_runner = _tidy_now


@router.post("/{bot_id}/memory/tidy")
async def memory_tidy(bot_id: str, user: str = Depends(require_admin)) -> dict:
    agent = _bot(bot_id)
    if not agent.get("memory_upkeep"):
        raise HTTPException(status_code=409, detail="turn on keeping its notes tidy first")
    try:
        result = await run_in_threadpool(tidy_runner, bot_id)
    except store.NotebookError as error:
        raise _fail(error)
    return {"queued": True, **(result or {})}


# -- opening the notebook folder ------------------------------------------------------------------------------------
def _open_target(kind: str, folder: str) -> None:
    """Fixed arguments, never a shell. The folder is the bot's own workspace, created if it is not there yet."""
    if kind == "obsidian":
        target = "obsidian://open?path=" + urllib.parse.quote(folder, safe="")
    else:
        target = folder
    if sys.platform.startswith("win"):
        os.startfile(target)   # noqa: S606 - the argument is our own folder or an obsidian:// URL we built
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target], shell=False)
    else:
        subprocess.Popen(["xdg-open", target], shell=False)


def _loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


opener = _open_target


@router.post("/{bot_id}/memory/open")
async def memory_open(bot_id: str, request: Request, body: OpenBody, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    if not _loopback(request):
        raise HTTPException(status_code=403, detail="the notebook can only be opened on the computer it is stored on")
    if body.target not in ("folder", "obsidian"):
        raise HTTPException(status_code=400, detail="open the folder or Obsidian")
    try:
        await run_in_threadpool(bot_memory.ensure_notebook, bot_id)
        folder = store.workspace(bot_id)
        folder.mkdir(parents=True, exist_ok=True)
        if store.is_reparse(folder):
            raise HTTPException(status_code=403, detail="that location is a link, which the notebook does not follow")
        await run_in_threadpool(opener, body.target, str(folder))
    except store.NotebookError as error:
        raise _fail(error)
    except OSError:
        raise HTTPException(status_code=400, detail="could not open it on this computer")
    return {"opened": body.target}
