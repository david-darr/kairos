"""The Design canvas's HTTP surface (spec 3c-3h): designs, boards, the board
render route and its CSP, assets, versions, comments, tokens, exports, design
systems, design chats, and the render-worker stream the desktop app reads.

People reach the designs they own (admins reach all); chats reach designs
through the tools in core/design_tools.py. Every change made here is a
version "by You" in the same log the models write to.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from core import (design_comments, design_export, design_html, design_render, design_render_bridge, design_store,
                  design_systems, design_tools)
from core.auth import auth_manager
from core.middleware import get_current_user, require_admin, require_user

router = APIRouter(prefix="/api/designs", tags=["designs"])
systems_router = APIRouter(prefix="/api/design-systems", tags=["designs"])
render_router = APIRouter(tags=["designs"])


def _admin(user: str) -> bool:
    return auth_manager.is_admin(user)


def _design(design_id: str, user: str) -> dict:
    try:
        return design_store.require_user_access(design_id, user, _admin(user))
    except LookupError:
        raise HTTPException(404, "Design not found") from None


def _owns_chat(session_id: str, user: str) -> dict:
    from services.chat_live import require_session
    return require_session(session_id, user)


def _fail(error: Exception):
    status = 404 if isinstance(error, LookupError) else 422
    raise HTTPException(status, str(error).strip("'\"")) from None


def _client(data: dict) -> dict:
    from core.session_manager import session_manager
    out = design_store.summary(data)
    out.update(boards=data.get("boards", {}), notes=data.get("notes", []),
               token_overrides=data.get("token_overrides") or {},
               order=[slug for slug, _ in design_store.ordered_boards(data)])
    out["chats"] = [{"id": sid, "title": (session_manager.get_session(sid) or {}).get("title") or "Chat"}
                    for sid in out["chat_ids"] if session_manager.get_session(sid)]
    system = design_systems.get(out["design_system"]) or design_systems.builtin()
    out["system"] = {"id": system["id"], "name": system["name"],
                     "variables": design_systems.variables(system["tokens"], data.get("token_overrides")),
                     "defaults": design_systems.variables(system["tokens"])}
    return out


# -- live redraw: design_changed on the existing chat stream --------------------

def _announce(packet: dict) -> None:
    from services import chat_live
    global _loop

    def send():
        chat_live._broadcast({"type": "design_changed", **packet})
    try:
        _loop = asyncio.get_running_loop()
        send()
        return
    except RuntimeError:
        pass  # A worker thread: hand it to the server's loop.
    if _loop is not None:
        _loop.call_soon_threadsafe(send)


_loop: Optional[asyncio.AbstractEventLoop] = None
design_store.on_change(_announce)


def _bind_loop():
    global _loop
    if _loop is None:
        try:
            _loop = asyncio.get_running_loop()
        except RuntimeError:
            pass


# -- designs ------------------------------------------------------------------------

class CreateDesign(BaseModel):
    title: str = Field(default="Untitled design", max_length=120)
    design_system: Optional[str] = None
    frame: str = "phone"
    session_id: Optional[str] = None


@router.get("")
async def list_designs(chat: Optional[str] = None, user: str = Depends(require_user)) -> list[dict]:
    _bind_loop()
    admin = _admin(user)
    items = [d for d in design_store.list_designs() if design_store.visible_to(d, user, admin)]
    if chat:
        items = [d for d in items if chat in (d.get("chat_ids") or [])]
    from core.session_manager import session_manager
    out = []
    for data in items:
        row = design_store.summary(data)
        row["board_titles"] = [info.get("title") for _, info in design_store.ordered_boards(data)][:6]
        row["chat_title"] = next(((session_manager.get_session(c) or {}).get("title") for c in row["chat_ids"]
                                  if session_manager.get_session(c)), None)
        out.append(row)
    return out


@router.post("")
async def create_design(body: CreateDesign, user: str = Depends(require_user)) -> dict:
    _bind_loop()
    if body.session_id:
        _owns_chat(body.session_id, user)
    try:
        data, _ = design_store.create(body.title, owner=user, chat_key_=body.session_id, by="You",
                                      design_system=body.design_system,
                                      boards=[{"title": "Screen 1", "frame": body.frame}])
    except (ValueError, LookupError) as error:
        _fail(error)
    return _client(data)


@router.get("/render-status")
async def render_status(user: str = Depends(require_user)) -> dict:
    return {"available": design_render_bridge.available(), "message": None if design_render_bridge.available()
            else design_render_bridge.NEEDS_APP}


@router.get("/{design_id}")
async def get_design(design_id: str, user: str = Depends(require_user)) -> dict:
    _bind_loop()
    data = _design(design_id, user)
    out = _client(data)
    out["comments"] = design_store.comments(design_id)
    out["render_available"] = design_render_bridge.available()
    return out


class PatchDesign(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)


@router.patch("/{design_id}")
async def patch_design(design_id: str, body: PatchDesign, user: str = Depends(require_user)) -> dict:
    data = _design(design_id, user)
    if body.title is not None:
        try:
            design_tools.board_action(data, {"action": "rename_design", "title": body.title}, by="You",
                                      session_id=None, user_edit=True)
        except (ValueError, LookupError) as error:
            _fail(error)
    return _client(design_store.manifest(design_id))


@router.delete("/{design_id}")
async def delete_design(design_id: str, user: str = Depends(require_user)) -> dict:
    data = _design(design_id, user)
    if data.get("owner") != user and not _admin(user):
        raise HTTPException(403, "Only the owner can delete a design")
    design_store.delete(design_id)
    return {"ok": True}


class LinkChat(BaseModel):
    session_id: str


@router.post("/{design_id}/link")
async def link_chat(design_id: str, body: LinkChat, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    _owns_chat(body.session_id, user)
    return _client(design_store.link_chat(design_id, body.session_id))


class Duplicate(BaseModel):
    version: Optional[int] = None


@router.post("/{design_id}/duplicate")
async def duplicate_design(design_id: str, body: Duplicate, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        return _client(design_store.duplicate(design_id, owner=user, by="You", version=body.version))
    except (ValueError, LookupError) as error:
        _fail(error)


class StartChat(BaseModel):
    design_id: Optional[str] = None
    title: str = Field(default="Design", max_length=120)


@router.post("/chat")
async def start_design_chat(body: StartChat, user: str = Depends(require_user)) -> dict:
    """A chat in Design mode (spec 3h): the design-canvas skill pinned on its
    first message and design_create offered directly; linked to a design
    when one is given."""
    from core.session_manager import session_manager
    if body.design_id:
        _design(body.design_id, user)
    session = session_manager.create_session(body.title or "Design", owner_user=user)
    design_store.set_design_mode(session["id"], True)
    if body.design_id:
        design_store.link_chat(body.design_id, session["id"])
    return {"session_id": session["id"]}


class DesignMode(BaseModel):
    on: bool = True


@router.post("/mode/{session_id}")
async def set_design_mode(session_id: str, body: DesignMode, user: str = Depends(require_user)) -> dict:
    _owns_chat(session_id, user)
    design_store.set_design_mode(session_id, body.on)
    return {"session_id": session_id, "design_mode": body.on}


@router.get("/mode/{session_id}")
async def get_design_mode(session_id: str, user: str = Depends(require_user)) -> dict:
    _owns_chat(session_id, user)
    return {"session_id": session_id, "design_mode": design_store.design_mode(session_id)}


# -- boards ---------------------------------------------------------------------------

def _render_response(design_id: str, slug: str, request: Request, version: Optional[int],
                     width: Optional[int] = None) -> HTMLResponse:
    try:
        page = design_render.render_document(design_id, slug, version=version, width=width)
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'\"")) from None
    origin = f"{request.url.scheme}://{request.url.netloc}"
    return HTMLResponse(page, headers={"Content-Security-Policy": design_render.csp(origin, design_id),
                                       "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "no-store",
                                       "X-Kairos-Design-Render": "1"})


@router.get("/{design_id}/boards/{slug}/render")
async def render_board(design_id: str, slug: str, request: Request, v: Optional[int] = None,
                       rt: Optional[str] = None, w: Optional[int] = None) -> HTMLResponse:
    if rt is not None:
        if not design_render.verify(design_id, slug, rt):
            raise HTTPException(404, "Design not found")
    else:
        user = get_current_user(request)
        if user is None:
            raise HTTPException(401, "authentication required")
        _design(design_id, user)
    return _render_response(design_id, slug, request, v, w)


def _asset(design_id: str, name: str) -> FileResponse:
    try:
        path = design_store.asset_path(design_id, name)
    except LookupError:
        raise HTTPException(404, "Not found") from None
    ext = path.suffix.lstrip(".")
    # Content-addressed and immutable: the name is the content's own hash, so
    # it needs no session (a sandboxed board frame sends none).
    return FileResponse(path, media_type=design_store.ASSET_TYPES.get(ext, "application/octet-stream"),
                        headers={"Cache-Control": "public, max-age=31536000, immutable",
                                 "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.get("/{design_id}/assets/{name}")
async def get_asset(design_id: str, name: str) -> FileResponse:
    return _asset(design_id, name)


@router.get("/{design_id}/boards/{slug}/assets/{name}")
async def get_board_asset(design_id: str, slug: str, name: str) -> FileResponse:
    return _asset(design_id, name)


class Upload(BaseModel):
    data_url: str = Field(max_length=36_000_000)


@router.post("/{design_id}/assets")
async def upload_asset(design_id: str, body: Upload, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        return {"path": design_store.asset_from_data_url(design_id, body.data_url)}
    except ValueError as error:
        _fail(error)


@router.get("/{design_id}/boards/{slug}/html")
async def board_source(design_id: str, slug: str, v: Optional[int] = None, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        text = design_store.board_at(design_id, slug, v) if v else design_store.board_html(design_id, slug)
    except LookupError as error:
        _fail(error)
    if text is None:
        raise HTTPException(404, "That board did not exist at this version")
    return {"html": text, "outline": design_html.outline(design_html.parse(text))}


@router.get("/{design_id}/boards/{slug}/thumb")
async def board_thumb(design_id: str, slug: str, user: str = Depends(require_user)) -> Response:
    _design(design_id, user)
    try:
        png = await design_render_bridge.thumbnail(design_id, slug)
    except (LookupError, design_render_bridge.Unavailable, RuntimeError):
        png = None
    if not png:
        raise HTTPException(404, "No thumbnail")
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


class AddBoard(BaseModel):
    title: str = Field(default="New board", max_length=80)
    frame: str = "phone"
    after: Optional[str] = None


@router.post("/{design_id}/boards")
async def add_board(design_id: str, body: AddBoard, user: str = Depends(require_user)) -> dict:
    data = _design(design_id, user)

    def edit(draft, files):
        slug, _ = design_store._add_board(draft, files, body.title, body.frame, None, after=body.after)
        return slug, f"Added board {body.title}"
    try:
        result = design_store.change(design_id, edit, by="You", tool="add_board", user_edit=True)
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"slug": result["result"], "design": _client(result["manifest"])}


class BoardAction(BaseModel):
    action: str
    board: Optional[str] = None
    title: Optional[str] = None
    order: Optional[int] = None
    x: Optional[int] = None
    y: Optional[int] = None
    w: Optional[int] = None
    h: Optional[int] = None
    frame: Optional[str] = None
    text: Optional[str] = None
    note_id: Optional[str] = None


@router.post("/{design_id}/board-action")
async def board_action(design_id: str, body: BoardAction, user: str = Depends(require_user)) -> dict:
    data = _design(design_id, user)
    try:
        message = design_tools.board_action(data, body.model_dump(exclude_none=True), by="You", session_id=None,
                                            user_edit=True)
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"message": message, "design": _client(design_store.manifest(design_id))}


class TextEdit(BaseModel):
    id: str
    text: str = Field(max_length=20000)


@router.post("/{design_id}/boards/{slug}/text")
async def edit_text(design_id: str, slug: str, body: TextEdit, user: str = Depends(require_user)) -> dict:
    """Text mode (spec 3f): a direct set_text, no model involved."""
    _design(design_id, user)
    return _user_ops(design_id, slug, [{"op": "set_text", "id": body.id, "text": body.text}], "Edited text")


class Ops(BaseModel):
    ops: list[dict[str, Any]]


@router.post("/{design_id}/boards/{slug}/ops")
async def edit_ops(design_id: str, slug: str, body: Ops, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    return _user_ops(design_id, slug, body.ops, "Edited")


def _user_ops(design_id: str, slug: str, ops: list, summary: str) -> dict:
    def edit(draft, files):
        if slug not in draft["boards"]:
            raise LookupError(f"No board `{slug}`.")
        text, touched, notes = design_html.apply_ops(design_store.board_html(design_id, slug), ops, slug)
        files[slug] = text
        return touched, f"{summary} on {draft['boards'][slug]['title']}"
    try:
        result = design_store.change(design_id, edit, by="You", tool="text_edit", user_edit=True)
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"version": result["version"], "changed": result["changed"]}


class Tokens(BaseModel):
    set: Optional[dict[str, str]] = None
    system: Optional[str] = None
    clear: Optional[bool] = None
    save_to_system: Optional[bool] = None


@router.post("/{design_id}/tokens")
async def set_tokens(design_id: str, body: Tokens, user: str = Depends(require_user)) -> dict:
    data = _design(design_id, user)
    if body.save_to_system:
        # "Save to system": writes the values into the design's own saved
        # system (admin only; the built-in Kairos system never changes).
        if not _admin(user):
            raise HTTPException(403, "Only an admin can change a design system")
        system = design_systems.get(data.get("design_system"))
        if not system or system["builtin"]:
            raise HTTPException(422, "The built-in Kairos system cannot be changed. Save a copy as a new system first.")
        tokens = system["tokens"]
        for name, value in (body.set or {}).items():
            role = name.removeprefix("--ds-")
            if role in tokens.get("color", {}):
                tokens["color"][role] = {"$type": "color", "$value": value}
        try:
            design_systems.save(system["name"], tokens, system.get("guide") or "", created_by=user,
                                source=system.get("source") or "", system_id=system["id"])
        except ValueError as error:
            _fail(error)
        return _client(design_store.manifest(design_id))
    try:
        design_tools.tokens_change(data, body.model_dump(exclude_none=True, exclude={"save_to_system"}), by="You",
                                   session_id=None, user_edit=True)
    except (ValueError, LookupError) as error:
        _fail(error)
    return _client(design_store.manifest(design_id))


# -- versions ---------------------------------------------------------------------------

@router.get("/{design_id}/versions")
async def list_versions(design_id: str, user: str = Depends(require_user)) -> list[dict]:
    _design(design_id, user)
    return design_store.versions(design_id)


@router.get("/{design_id}/versions/{n}")
async def get_version(design_id: str, n: int, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        entry = design_store.version_entry(design_id, n)
    except LookupError as error:
        _fail(error)
    return entry


@router.post("/{design_id}/versions/{n}/restore")
async def restore_version(design_id: str, n: int, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        result = design_store.restore(design_id, n, by="You")
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"version": result["version"], "design": _client(result["manifest"])}


class NameVersion(BaseModel):
    name: Optional[str] = Field(default=None, max_length=60)


@router.post("/{design_id}/versions/{n}/name")
async def name_version(design_id: str, n: int, body: NameVersion, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        return design_store.name_version(design_id, n, body.name)
    except LookupError as error:
        _fail(error)


@router.post("/{design_id}/undo")
async def undo(design_id: str, user: str = Depends(require_user)) -> dict:
    """Ctrl+Z in the viewer: step back over your own latest direct edit."""
    data = _design(design_id, user)
    entries = design_store.versions(design_id)
    if len(entries) < 2 or not entries[0].get("user_edit") or entries[0]["tool"] == "restore":
        raise HTTPException(409, "Nothing of yours to undo. Use Versions to go further back.")
    result = design_store.restore(design_id, entries[1]["n"], by="You")
    return {"version": result["version"], "design": _client(result["manifest"])}


# -- comments ----------------------------------------------------------------------

class NewComment(BaseModel):
    board: str
    element_ids: list[str] = []
    point: Optional[dict[str, float]] = None
    text: str = Field(min_length=1, max_length=4000)


@router.get("/{design_id}/comments")
async def list_comments(design_id: str, user: str = Depends(require_user)) -> list[dict]:
    _design(design_id, user)
    return design_store.comments(design_id)


@router.post("/{design_id}/comments")
async def add_comment(design_id: str, body: NewComment, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        return design_store.add_comment(design_id, board=body.board, element_ids=body.element_ids, point=body.point,
                                        text=body.text, author=user)
    except (ValueError, LookupError) as error:
        _fail(error)


class PatchComment(BaseModel):
    status: Optional[str] = None
    text: Optional[str] = Field(default=None, max_length=4000)


@router.patch("/{design_id}/comments/{comment_id}")
async def patch_comment(design_id: str, comment_id: str, body: PatchComment, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    try:
        return design_store.update_comment(design_id, comment_id, status=body.status, text=body.text)
    except (ValueError, LookupError) as error:
        _fail(error)


@router.delete("/{design_id}/comments/{comment_id}")
async def delete_comment(design_id: str, comment_id: str, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    design_store.delete_comment(design_id, comment_id)
    return {"ok": True}


# -- export ----------------------------------------------------------------------------

class Export(BaseModel):
    format: str
    boards: Optional[list[str]] = None
    session_id: Optional[str] = None


@router.post("/{design_id}/export")
async def export_design(design_id: str, body: Export, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    if body.session_id:
        _owns_chat(body.session_id, user)
    try:
        filename, raw = await design_export.export(design_id, body.format, body.boards)
    except design_render_bridge.Unavailable as error:
        raise HTTPException(503, str(error)) from None
    except (ValueError, LookupError) as error:
        _fail(error)
    published = design_export.publish(filename, raw)
    if body.session_id:
        from core.session_manager import session_manager
        session_manager.register_artifact(body.session_id, published["url"])
    return {"filename": filename, "url": published["url"], "size": len(raw)}


# -- phase 4: build this in Forge ------------------------------------------------------

class ForgeHandoff(BaseModel):
    project_id: str
    model_endpoint_id: Optional[str] = None
    boards: Optional[list[str]] = None


def handoff_task(data: dict, boards: Optional[list[str]] = None) -> str:
    slugs = boards or [slug for slug, _ in design_store.ordered_boards(data)]
    listing = "\n".join(f"- {slug}: \"{data['boards'][slug]['title']}\" ({data['boards'][slug]['frame']})"
                        for slug in slugs if slug in data["boards"])
    return (f"Build the design \"{data.get('title')}\" (design id {data['id']}) in this project.\n"
            f"Read it with design_outline, design_read for each board and design_tokens. Map its --ds-* tokens onto "
            f"this project's own styles or theme variables rather than copying raw values, and build each board as a "
            f"screen or component in the project's framework.\nBoards:\n{listing}\n"
            f"When you finish, list which file implements which board slug, so each screen can be traced to its board.")[:4000]


@router.post("/{design_id}/forge")
async def build_in_forge(design_id: str, body: ForgeHandoff, user: str = Depends(require_admin)) -> dict:
    from services.forge_sessions import forge_sessions
    data = _design(design_id, user)
    task = handoff_task(data, body.boards)
    try:
        session = await asyncio.to_thread(forge_sessions.create, body.project_id, task, body.model_endpoint_id,
                                          "build", "new_worktree", None, None, user, None)
    except Exception as error:
        raise HTTPException(422, str(getattr(error, "detail", None) or error)) from None
    design_store.link_chat(design_id, session["id"])
    return {"session_id": session["id"], "task": task}


# -- design systems ----------------------------------------------------------------------

@systems_router.get("")
async def list_systems(user: str = Depends(require_user)) -> list[dict]:
    return design_systems.list_systems()


@systems_router.get("/{system_id}")
async def get_system(system_id: str, user: str = Depends(require_user)) -> dict:
    system = design_systems.get(system_id)
    if system is None:
        raise HTTPException(404, "Design system not found")
    return {**system, "variables": design_systems.variables(system["tokens"])}


class NewSystem(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    colors: dict[str, str] = {}
    fonts: dict[str, str] = {}
    guide: str = Field(default="", max_length=4000)
    css: Optional[str] = Field(default=None, max_length=400_000)
    forge_project_id: Optional[str] = None


@systems_router.post("")
async def create_system(body: NewSystem, user: str = Depends(require_admin)) -> dict:
    """Tool Store > Design systems > New: from a palette and fonts, pasted CSS
    variables, or a Forge project's CSS (read only from the repo)."""
    try:
        if body.forge_project_id:
            css, source = _forge_css(body.forge_project_id)
            return design_systems.from_css(body.name, css, created_by=user, source=source)
        if body.css:
            return design_systems.from_css(body.name, body.css, created_by=user, source="pasted CSS")
        return design_systems.save(body.name, {"color": body.colors, "font": body.fonts}, body.guide,
                                   created_by=user, source="Tool Store")
    except ValueError as error:
        _fail(error)


def _forge_css(project_id: str) -> tuple[str, str]:
    """CSS custom properties from a Forge project's stylesheets and Tailwind
    config, read only (never written), at most 60 files and 2 MB."""
    from pathlib import Path
    from services.forge_projects import forge_projects
    project = next((p for p in forge_projects.list() if p.get("id") == project_id), None)
    if project is None:
        raise ValueError("Forge project not found.")
    root = Path(project["path"]).resolve()
    texts, total = [], 0
    skip = {"node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next"}
    for path in root.rglob("*"):
        if any(part in skip for part in path.relative_to(root).parts):
            continue
        if path.is_file() and (path.suffix in (".css", ".scss") or path.name.startswith("tailwind.config")):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")[:200_000]
            except OSError:
                continue
            texts.append(text)
            total += len(text)
            if len(texts) >= 60 or total > 2_000_000:
                break
    if not texts:
        raise ValueError("No stylesheets were found in that project.")
    css = "\n".join(texts)
    # Tailwind config colours ("primary: '#123456'") become variables too.
    css += "\n" + "\n".join(f"--{name}: {value};" for name, value in
                            re.findall(r"['\"]?([A-Za-z][A-Za-z0-9-]{1,30})['\"]?\s*:\s*['\"](#[0-9a-fA-F]{3,8})['\"]", css))
    return css, f"Forge project {project.get('name')}"


@systems_router.delete("/{system_id}")
async def delete_system(system_id: str, user: str = Depends(require_admin)) -> dict:
    import shutil
    from pathlib import Path
    if system_id == design_systems.BUILTIN_ID or not design_systems.ID_RE.fullmatch(system_id):
        raise HTTPException(422, "The built-in Kairos system cannot be removed")
    shutil.rmtree(Path(design_systems.SYSTEMS_DIR, system_id), ignore_errors=True)
    return {"ok": True}


# -- fonts and the render worker --------------------------------------------------------

@render_router.get("/api/design-fonts/{system_id}/{file}")
async def design_font(system_id: str, file: str) -> FileResponse:
    """A design system's self-hosted font. Board frames are opaque-origin, so
    their font requests carry no session and need CORS; fonts are app assets,
    already public under /static."""
    path = design_systems.font_path("kairos" if system_id == "kairos" else system_id, file)
    if path is None:
        raise HTTPException(404, "Not found")
    return FileResponse(path, media_type="font/woff2" if file.endswith(".woff2") else "font/ttf",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"})


def _worker(request: Request) -> None:
    if not design_render_bridge.token_ok(request.headers.get("X-Kairos-Render-Token")):
        raise HTTPException(404, "Not found")
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(404, "Not found")


@render_router.get("/api/design-render/jobs")
async def render_jobs(request: Request) -> StreamingResponse:
    _worker(request)
    _bind_loop()
    return StreamingResponse(design_render_bridge.worker_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@render_router.post("/api/design-render/result/{job_id}")
async def render_result(job_id: str, request: Request) -> dict:
    _worker(request)
    body = await request.body()
    error = request.headers.get("X-Kairos-Render-Error")
    if len(body) > 60 * 1024 * 1024:
        raise HTTPException(413, "Too large")
    return {"ok": design_render_bridge.complete(job_id, body, error)}
