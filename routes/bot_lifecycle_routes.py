"""Admin lifecycle surfaces; imported text never becomes a tool invocation."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_admin
from services import bot_package
from services.bot_package_import import ImportFailure

router = APIRouter(prefix="/api/bot-lifecycle", tags=["bot-lifecycle"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReportBody(Body):
    session_id: str = Field(min_length=1, max_length=100)
    message_id: str = Field(min_length=1, max_length=100)
    went_wrong: str = Field(min_length=1, max_length=2000)
    you_saw: str = Field(default="", max_length=3000)
    steps: str = Field(default="", max_length=2000)


class ExportOptions(Body):
    name: str = Field(default="Bot package", min_length=1, max_length=100)
    description: str = Field(default="", max_length=4000)
    routines: bool = True
    memory: bool = False
    sections: list[str] = Field(default_factory=list, max_length=20)


class ExportBody(Body):
    bot_ids: list[str] = Field(min_length=1, max_length=100)
    options: ExportOptions = Field(default_factory=ExportOptions)


class Selection(Body):
    bots: list[str] = Field(default_factory=list, max_length=200)
    skills: list[str] = Field(default_factory=list, max_length=60)
    presets: list[str] = Field(default_factory=list, max_length=20)
    connections: list[str] = Field(default_factory=list, max_length=20)
    sections: list[str] = Field(default_factory=list, max_length=20)


class ImportBody(Body):
    token: str = Field(pattern=r"^[a-f0-9]{32}$")
    selection: Selection | None = None


@contextmanager
def guard():
    try:
        yield
    except ImportFailure as exc:
        raise HTTPException(409, {"message": str(exc), "cleanup_errors": exc.cleanup_errors}) from exc
    except KeyError:
        raise HTTPException(404, "Not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def upload(request, limit, suffixes, *, password=False):
    # Bound the stream BEFORE multipart parsing allocates a spooled file.
    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > limit + 65536:
            raise HTTPException(413, "File is too large")
        chunks.extend(chunk)
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        raise HTTPException(422, "Choose a file")
    async def receive():
        return {"type": "http.request", "body": bytes(chunks), "more_body": False}
    bounded = Request(request.scope, receive)
    async with bounded.form(max_files=1, max_fields=1 if password else 0, max_part_size=limit) as form:
        file = form.get("file")
        if not hasattr(file, "read") or not (file.filename or "").lower().endswith(suffixes):
            raise HTTPException(422, "Choose a supported file")
        raw = await file.read(limit + 1)
        if len(raw) > limit:
            raise HTTPException(413, "File is too large")
        return raw, str(form.get("password", ""))


@router.get("/templates")
async def templates(user: str = Depends(require_admin)):
    from pathlib import Path
    import json
    root = Path(__file__).resolve().parents[1] / "static" / "data"
    return {"teams": json.loads((root / "bots-teams.json").read_text(encoding="utf-8")),
            "ready": json.loads((root / "bots-ready.json").read_text(encoding="utf-8"))}


@router.post("/packages/export-preview")
async def export_preview(body: ExportBody, user: str = Depends(require_admin)):
    with guard():
        return await asyncio.to_thread(bot_package.export_preview, body.bot_ids, body.options.model_dump(), owner_user=user)


@router.post("/packages/export")
async def export(body: ExportBody, user: str = Depends(require_admin)):
    with guard():
        raw = await asyncio.to_thread(bot_package.export_bytes, body.bot_ids, body.options.model_dump(), owner_user=user)
    return Response(raw, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="bots.kairos.json"'})


@router.post("/packages/inspect")
async def inspect(request: Request, user: str = Depends(require_admin)):
    with guard():
        raw, _ = await upload(request, bot_package.MAX_BYTES, (".json", ".md"))
        return await asyncio.to_thread(bot_package.inspect, raw, owner_user=user)


@router.post("/packages/import")
async def import_package(body: ImportBody, user: str = Depends(require_admin)):
    with guard():
        return await asyncio.to_thread(bot_package.import_, body.token, body.selection.model_dump() if body.selection else None,
                                       owner_user=user)


class ScoutBody(Body):
    path: str = Field(min_length=1, max_length=4096)


@router.post("/packages/scout")
async def scout(body: ScoutBody, user: str = Depends(require_admin)):
    from services.bot_scout import scout as run
    with guard():
        return await asyncio.to_thread(run, body.path, owner_user=user)


class PasswordBody(Body):
    password: str = Field(min_length=12, max_length=1024)


class RestoreBody(PasswordBody):
    upload_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    confirm: Literal["REPLACE"]


@router.post("/backups/export")
async def backup_export(body: PasswordBody, user: str = Depends(require_admin)):
    import shutil
    from services import bot_backup
    folder = bot_backup._scratch()
    path = folder / "workspace.kbackup"
    try:
        with guard():
            await asyncio.to_thread(bot_backup.export, body.password, path)
        return FileResponse(str(path), filename="workspace.kbackup", media_type="application/octet-stream",
                            background=BackgroundTask(shutil.rmtree, folder))
    except BaseException:
        shutil.rmtree(folder)
        raise


@router.post("/backups/preview")
async def backup_preview(request: Request, user: str = Depends(require_admin)):
    import shutil
    from services import bot_backup
    # Stream-limit multipart input, and let Starlette spool the file to disk.
    # Never materialize a multi-GB backup as a request-sized bytearray.
    stream = request.stream().__aiter__()
    received = 0
    async def receive():
        nonlocal received
        try:
            chunk = await anext(stream)
        except StopAsyncIteration:
            return {"type": "http.request", "body": b"", "more_body": False}
        received += len(chunk)
        if received > bot_backup.MAX_BYTES + 69632:
            raise HTTPException(413, "Backup exceeds 10 GB")
        return {"type": "http.request", "body": chunk, "more_body": bool(chunk)}
    bounded = Request(request.scope, receive)
    folder = bot_backup._scratch()
    try:
        async with bounded.form(max_files=1, max_fields=1, max_part_size=4096) as form:
            file = form.get("file")
            if not hasattr(file, "read") or not (file.filename or "").lower().endswith(".kbackup"):
                raise HTTPException(422, "Choose a .kbackup file")
            path = folder / "incoming.kbackup"
            with path.open("wb") as dest:
                while chunk := await file.read(bot_backup.CHUNK):
                    dest.write(chunk)
            with guard():
                return await asyncio.to_thread(bot_backup.preview, path, form.get("password", ""), owner_user=user)
    finally:
        shutil.rmtree(folder)


@router.post("/backups/restore")
async def backup_restore(body: RestoreBody, user: str = Depends(require_admin)):
    from services import bot_backup
    with guard():
        return await asyncio.to_thread(bot_backup.restore, body.upload_id, body.password, body.confirm, owner_user=user)


# -- problem reports (F101): drafted and kept on this computer, never sent ----------------------------------------
@router.post("/reports")
async def report_draft(body: ReportBody, user: str = Depends(require_admin)):
    from services import bot_report
    return await asyncio.to_thread(bot_report.draft, user, session_id=body.session_id, message_id=body.message_id,
                                   went_wrong=body.went_wrong, you_saw=body.you_saw, steps=body.steps)


@router.post("/reports/open-folder")
async def report_folder(user: str = Depends(require_admin)):
    """Show the reports folder. Fixed arguments, never a shell; the folder is Kairos's own."""
    import os
    import subprocess
    import sys
    from services import bot_report
    os.makedirs(bot_report.root(), exist_ok=True)
    if sys.platform.startswith("win"):
        os.startfile(bot_report.root())  # noqa: S606 - our own data folder
    elif sys.platform == "darwin":
        subprocess.Popen(["open", bot_report.root()], shell=False)
    else:
        subprocess.Popen(["xdg-open", bot_report.root()], shell=False)
    return {"ok": True}


@router.get("/reports/{ident}")
async def report_get(ident: str, user: str = Depends(require_admin)):
    from services import bot_report
    return await asyncio.to_thread(bot_report.get, user, ident)
