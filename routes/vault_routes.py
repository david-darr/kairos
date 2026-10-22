"""Vault graph + note read/write — Library's Vault view (David's ask
2026-09-01, ported from the original kiosk's /vault-graph and /vault-note).

Library Vault Polish (locked 2026-10-22): reading stays open to signed-in
users; every write (save, today's note) is admin only, version-checked and
checkpointed. "What changed" is admin data, like the checkpoint routes.
"""
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core import vault_graph, vault_library, vault_sync
from core.auth import auth_manager
from core.middleware import require_admin, require_user
from core.vault import resolve_vault_dir

router = APIRouter(prefix="/api/vault", tags=["vault"])


@router.post("/sync")
async def sync_vault(user: str = Depends(require_user)) -> dict:
    """Pull the vault's task list into Notes (David's ask 2026-09-03 — the
    app answered "no priorities" while the vault was full of them). Runs
    automatically at startup; this is the manual re-run for when the vault
    has been edited in Obsidian while the app is open."""
    return vault_sync.sync_from_vault()


class WriteNoteRequest(BaseModel):
    path: str
    content: str
    version: str = ""
    allow_remove_properties: bool = False


class PinsRequest(BaseModel):
    pins: list


@router.get("/graph")
async def get_vault_graph(user: str = Depends(require_user)) -> dict:
    return vault_graph.build_vault_graph()


@router.get("/note")
async def get_vault_note(path: str = Query(...), user: str = Depends(require_user)) -> dict:
    note = vault_graph.read_vault_note_full(path)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    note["links"] = vault_graph.resolve_links(note["content"])
    note["backlinks"] = vault_graph.backlink_contexts(note["path"])
    note["can_edit"] = auth_manager.is_admin(user) and note["editable"]
    if auth_manager.is_admin(user):
        note["last_change"] = vault_library.last_change(path, user)
    return note


@router.post("/note")
async def post_vault_note(body: WriteNoteRequest, user: str = Depends(require_admin)):
    if not body.version:
        raise HTTPException(status_code=400, detail="Reload the note before saving: no version was sent.")
    try:
        saved = vault_graph.save_vault_note(body.path, body.content, body.version, user, body.allow_remove_properties)
    except vault_graph.VersionConflict as conflict:
        return JSONResponse(status_code=409, content={"detail": "This note changed since you opened it.",
                                                      "code": "version_conflict", "current_version": conflict.current})
    except vault_graph.PropertiesRemoved as problem:
        return JSONResponse(status_code=409, content={"detail": str(problem), "code": "properties_removed"})
    except ValueError as problem:
        raise HTTPException(status_code=400, detail=str(problem))
    if saved is None:
        raise HTTPException(status_code=404, detail="note not found")
    return {"ok": True, **saved}


@router.get("/search")
async def search_vault(q: str = Query(""), user: str = Depends(require_user)) -> dict:
    return {"query": q, "mark": [vault_library.MARK_OPEN, vault_library.MARK_CLOSE], "results": vault_library.search(q)}


@router.get("/related")
async def related_notes(path: str = Query(...), user: str = Depends(require_user)) -> dict:
    return {"path": path, "results": vault_library.related(path)}


@router.get("/pins")
async def get_pins(user: str = Depends(require_user)) -> dict:
    return {"pins": vault_library.get_pins(user)}


@router.put("/pins")
async def put_pins(body: PinsRequest, user: str = Depends(require_user)) -> dict:
    try:
        return {"pins": vault_library.set_pins(user, body.pins)}
    except ValueError as problem:
        raise HTTPException(status_code=400, detail=str(problem))


@router.get("/activity")
async def vault_activity(path: str = Query(""), user: str = Depends(require_admin)) -> dict:
    if path:
        return vault_library.note_history(path, user)
    return {"recent": vault_library.recent_changes(user)}


@router.get("/daily")
async def daily_status(user: str = Depends(require_user)) -> dict:
    folder, template = vault_library.daily_settings()
    today = datetime.now()
    path = vault_graph.daily_note_target(os.path.realpath(resolve_vault_dir()), folder, today)
    real, template_real = vault_graph._vault_real_path(path), vault_graph._vault_real_path(template)
    return {"date": today.strftime("%Y-%m-%d"), "path": path, "exists": bool(real and os.path.isfile(real)),
            "folder": folder, "template": template, "template_exists": bool(template_real and os.path.isfile(template_real)),
            "can_create": auth_manager.is_admin(user)}


@router.post("/daily")
async def create_daily(user: str = Depends(require_admin)) -> dict:
    folder, template = vault_library.daily_settings()
    try:
        path, created = vault_graph.create_daily_note(template, folder, datetime.now(), user)
    except FileNotFoundError as problem:
        raise HTTPException(status_code=404, detail=str(problem))
    except (ValueError, UnicodeDecodeError) as problem:
        raise HTTPException(status_code=400, detail=str(problem))
    return {"path": path, "created": created, "index": vault_graph.index_proposal(folder, path) if created else None}


@router.get("/obsidian-url")
async def obsidian_url(path: str = Query(...), user: str = Depends(require_admin)) -> dict:
    url = vault_library.obsidian_url(path)
    if not url:
        raise HTTPException(status_code=404, detail="note not found")
    return {"url": url}
