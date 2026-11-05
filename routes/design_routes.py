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

from core import (design_comments, design_export, design_formats, design_html, design_render, design_render_bridge,
                  design_store, design_systems, design_tools)
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
    order = [slug for slug, _ in design_store.ordered_boards(data)]
    boards = {}
    for slug, info in data.get("boards", {}).items():
        # What the canvas needs to keep a board true to its format: its label,
        # its ratio (fixed formats), whether it grows (website, email), and for
        # a board made before formats, its nearest format ("Fit to format").
        extra = {"format_label": design_formats.label(info), "ratio": design_formats.ratio(info),
                 "grows": design_formats.grows(info), "section": design_formats.section_key(info)}
        if not info.get("format"):
            guess = design_formats.infer(info)
            extra["format_guess"] = ({k: guess[k] for k in ("format", "size", "orientation", "w", "h")}
                                     | {"label": design_formats.label(guess)}) if guess else None
        boards[slug] = {**info, **extra}
    out.update(boards=boards, notes=data.get("notes", []), token_overrides=data.get("token_overrides") or {},
               order=order, layout=data.get("layout") or "free",
               sections=design_formats.sections(data.get("boards", {}), order) if data.get("layout") == "auto" else [],
               formats=_formats())
    out["chats"] = [{"id": sid, "title": (session_manager.get_session(sid) or {}).get("title") or "Chat"}
                    for sid in out["chat_ids"] if session_manager.get_session(sid)]
    system = design_systems.get(out["design_system"]) or design_systems.builtin()
    out["system"] = {"id": system["id"], "name": system["name"],
                     "variables": design_systems.variables(system["tokens"], data.get("token_overrides")),
                     "defaults": design_systems.variables(system["tokens"])}
    return out


def _formats() -> list[dict]:
    """The format menu (Add board, Fit to format), from design_formats."""
    out = []
    for fid, spec in design_formats.FORMATS.items():
        if fid == "custom":
            continue
        options = []
        for size, info in spec["sizes"].items():
            orientations = [info["only"]] if info.get("only") else list(spec["orientations"]) or [None]
            for orientation in orientations:
                board = design_formats.resolve(fid, size=size, orientation=orientation)[0]
                options.append({"format": fid, "size": size, "orientation": orientation,
                                "label": design_formats.label(board), "w": board["w"], "h": board["h"],
                                "grows": bool(board["grow"])})
        out.append({"id": fid, "label": spec["label"], "options": options})
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
    frame: Optional[str] = None
    format: Optional[str] = None
    size: Optional[str] = None
    orientation: Optional[str] = None
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
        board = {"title": "Screen 1", "format": body.format, "size": body.size, "orientation": body.orientation,
                 "frame": body.frame}
        if not body.format and not body.frame:
            board.update(format="app", size="phone", orientation="portrait")
        data, _ = design_store.create(body.title, owner=user, chat_key_=body.session_id, by="You",
                                      design_system=body.design_system, boards=[board])
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


@router.get("/{design_id}/boards/{slug}/pages")
async def board_pages(design_id: str, slug: str, user: str = Depends(require_user)) -> dict:
    """A document board's printed pages: how many, rendered (or refreshed) first when the desktop app is here."""
    data = _design(design_id, user)
    if slug not in data["boards"] or not design_formats.paged(data["boards"][slug]):
        raise HTTPException(404, "Not a document board")
    try:
        images = await design_render_bridge.pages(design_id, slug)
    except (design_render_bridge.Unavailable, RuntimeError) as error:
        raise HTTPException(503, str(error)) from None
    if not images:
        raise HTTPException(503, design_render_bridge.NEEDS_APP)
    return {"count": len(images), "key": design_store.board_hash(design_id, slug)}


@router.get("/{design_id}/boards/{slug}/pages/{n}")
async def board_page(design_id: str, slug: str, n: int, user: str = Depends(require_user)) -> Response:
    _design(design_id, user)
    files = design_render_bridge.cached_pages(design_id, slug)
    if not 1 <= n <= len(files):
        raise HTTPException(404, "No such page")
    return Response(files[n - 1].read_bytes(), media_type="image/png", headers={"Cache-Control": "no-store"})


class AddBoard(BaseModel):
    title: str = Field(default="New board", max_length=80)
    frame: Optional[str] = None
    format: Optional[str] = None
    size: Optional[str] = None
    orientation: Optional[str] = None
    w: Optional[int] = None
    h: Optional[int] = None
    after: Optional[str] = None


@router.post("/{design_id}/boards")
async def add_board(design_id: str, body: AddBoard, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)

    def edit(draft, files):
        made = design_store.add_boards(draft, files, body.title, design_store.board_specs(body.model_dump()), None,
                                       after=body.after)
        return [slug for slug, _ in made], f"Added board {body.title}"
    try:
        result = design_store.change(design_id, edit, by="You", tool="add_board", user_edit=True)
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"slug": result["result"][0], "slugs": result["result"], "design": _client(result["manifest"])}


class FitHeight(BaseModel):
    h: int = Field(ge=1, le=100000)


@router.post("/{design_id}/boards/{slug}/fit-height")
async def fit_height(design_id: str, slug: str, body: FitHeight, user: str = Depends(require_user)) -> dict:
    """A website or email board measured by the canvas: as tall as its content
    (no version; the rows below move)."""
    _design(design_id, user)
    try:
        result = design_store.fit_height(design_id, slug, body.h)
    except (ValueError, LookupError) as error:
        _fail(error)
    return {"h": result["manifest"]["boards"][slug]["h"], "design": _client(result["manifest"])}


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
    format: Optional[str] = None
    size: Optional[str] = None
    orientation: Optional[str] = None
    reflow: Optional[bool] = None
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
    pptx_mode: str = "editable"
    fonts: str = "office"


@router.post("/{design_id}/export")
async def export_design(design_id: str, body: Export, user: str = Depends(require_user)) -> dict:
    _design(design_id, user)
    if body.session_id:
        _owns_chat(body.session_id, user)
    try:
        filename, raw, notes = await design_export.export(design_id, body.format, body.boards,
                                                          pptx_mode=body.pptx_mode, fonts=body.fonts)
    except design_render_bridge.Unavailable as error:
        raise HTTPException(503, str(error)) from None
    except (ValueError, LookupError) as error:
        _fail(error)
    published = design_export.publish(filename, raw)
    if body.session_id:
        from core.session_manager import session_manager
        session_manager.register_artifact(body.session_id, published["url"])
    return {"filename": filename, "url": published["url"], "size": len(raw), "notes": notes}


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
    return design_systems.list_systems(user, _admin(user))


def _preview_token(system_id: str) -> str:
    return design_render.sign(system_id, "style-preview", 3600)


@systems_router.get("/{system_id}")
async def get_system(system_id: str, user: str = Depends(require_user)) -> dict:
    system = design_systems.get(system_id)
    if not design_systems.visible(system, user, _admin(user)):
        raise HTTPException(404, "Design system not found")
    out = {**system, "variables": design_systems.variables(system["tokens"])}
    if system.get("style"):
        out.update(preview_token=_preview_token(system_id), mine=system.get("owner") == user)
    return out


# -- styles from references (Creative Output Quality spec, Phase 1b) -----------------------

_FONT_OPTIONS = None


def _draft_reply(record: dict) -> dict:
    from core import design_looks
    global _FONT_OPTIONS
    _FONT_OPTIONS = _FONT_OPTIONS or [{"id": key, "name": name} for key, (name, _) in design_looks.FAMILIES.items()]
    return {**record, "preview_token": _preview_token(record["id"]), "font_options": _FONT_OPTIONS,
            "variables": design_systems.variables(design_looks.tokens(record["look"]))}


@systems_router.post("/drafts")
async def draft_from_references(request: Request, user: str = Depends(require_user)) -> dict:
    """Tool Store > New style from references: up to 8 files, read locally into a draft. The files
    are parsed in a temporary folder and deleted at once; only the extracted values are kept (D12)."""
    import shutil
    import tempfile
    from pathlib import Path
    from core import design_references
    form = await request.form()
    uploads = [item for item in form.getlist("files") if hasattr(item, "read")][: design_references.MAX_FILES + 1]
    if not uploads:
        raise HTTPException(422, "Add at least one photo, screenshot, PDF, PowerPoint or Word file.")
    if len(uploads) > design_references.MAX_FILES:
        raise HTTPException(422, f"At most {design_references.MAX_FILES} files per style.")
    folder = Path(tempfile.mkdtemp(prefix="kairos-style-"))
    evidence, skipped = [], []
    try:
        for n, upload in enumerate(uploads):
            content = await upload.read(design_references.MAX_BYTES + 1)
            name = (getattr(upload, "filename", None) or f"file {n + 1}")[:80]
            if len(content) > design_references.MAX_BYTES:
                skipped.append(f"{name}: over 25 MB")
                continue
            path = folder / f"{n}"
            path.write_bytes(content)
            try:
                evidence.append(design_references.read(path, name))
            except design_references.ReferenceError as error:
                skipped.append(f"{name}: {error}")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    if not evidence:
        raise HTTPException(422, "None of the files could be read: " + "; ".join(skipped))
    try:
        result = design_references.draft(evidence, str(form.get("name") or "")[:60], str(form.get("notes") or "")[:300])
    except design_references.ReferenceError as error:
        raise HTTPException(422, str(error))
    record = design_references.save_draft(result, user)
    return {**_draft_reply(record), "skipped": skipped}


class StyleAdjust(BaseModel):
    colors: Optional[dict[str, str]] = None
    fonts: Optional[dict[str, str]] = None
    shape: Optional[dict[str, str]] = None
    name: Optional[str] = Field(default=None, max_length=60)


@systems_router.post("/drafts/{draft_id}")
async def adjust_draft(draft_id: str, body: StyleAdjust, user: str = Depends(require_user)) -> dict:
    from core import design_references
    try:
        record = design_references.load_draft(draft_id, user)
        look, notes = design_references.adjust(record["look"], colors=body.colors, fonts=body.fonts,
                                               shape=body.shape, name=body.name)
    except LookupError as error:
        raise HTTPException(404, str(error))
    except design_references.ReferenceError as error:
        raise HTTPException(422, str(error))
    record = design_references.save_draft({"look": look, "changes": record["changes"] + notes,
                                           "sources": record["sources"]}, user, draft_id)
    return _draft_reply(record)


@systems_router.post("/drafts/{draft_id}/save")
async def save_draft(draft_id: str, user: str = Depends(require_user)) -> dict:
    """The person's own click saves it: theirs, private until an admin shares it (D10)."""
    from core import design_references
    try:
        record = design_references.load_draft(draft_id, user)
    except LookupError as error:
        raise HTTPException(404, str(error))
    system = design_systems.save_style(record["look"], owner=user, sources=record["sources"])
    design_references.drop_draft(draft_id)
    return {**system, "variables": design_systems.variables(system["tokens"]), "preview_token": _preview_token(system["id"])}


class ShareStyle(BaseModel):
    shared: bool


@systems_router.post("/{system_id}/share")
async def share_style(system_id: str, body: ShareStyle, user: str = Depends(require_admin)) -> dict:
    try:
        return design_systems.share_style(system_id, body.shared)
    except LookupError:
        raise HTTPException(404, "Style not found")


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


class DefaultLook(BaseModel):
    id: Optional[str] = Field(default=None, max_length=60)


@systems_router.get("/default/look")
async def get_default_look(user: str = Depends(require_user)) -> dict:
    return {"id": design_systems.default_id()}


@systems_router.post("/default/look")
async def set_default_look(body: DefaultLook, user: str = Depends(require_admin)) -> dict:
    """Use as default: the look new designs start in when nobody chose one. None clears it."""
    from core import settings as settings_store
    if body.id is not None and design_systems.get(body.id) is None:
        raise HTTPException(404, "Design system not found")
    settings_store.update_settings(design_default_look=body.id)
    return {"id": design_systems.default_id()}


@systems_router.delete("/{system_id}")
async def delete_system(system_id: str, user: str = Depends(require_user)) -> dict:
    """An admin removes any saved system; a person removes their own style."""
    import shutil
    from pathlib import Path
    from core import design_looks
    if system_id == design_systems.BUILTIN_ID or not design_systems.ID_RE.fullmatch(system_id):
        raise HTTPException(422, "The built-in Kairos system cannot be removed")
    if design_looks.get(system_id):
        raise HTTPException(422, "Bundled looks ship with Kairos and cannot be removed")
    system = design_systems.get(system_id)
    if not _admin(user) and not (system and system.get("style") and system.get("owner") == user):
        raise HTTPException(403, "admin privileges required")
    shutil.rmtree(Path(design_systems.SYSTEMS_DIR, system_id), ignore_errors=True)
    return {"ok": True}


# -- fonts and the render worker --------------------------------------------------------

@render_router.get("/api/design-looks/{system_id}/preview")
async def look_preview(system_id: str, request: Request, rt: Optional[str] = None) -> HTMLResponse:
    """A look's preview board for Tool Store cards. Bundled looks and Kairos need no session (the
    card's frame is sandboxed and sends none); a person's style or draft is private, so it needs the
    token its owner's authenticated read handed out (rt). No script runs."""
    page = design_render.render_sample(system_id, rt=rt) if design_systems.ID_RE.fullmatch(system_id or "") else None
    if page is None:
        raise HTTPException(404, "Not found")
    origin = f"{request.url.scheme}://{request.url.netloc}"
    return HTMLResponse(page, headers={"Content-Security-Policy": design_render.sample_csp(origin),
                                       "X-Kairos-Design-Render": "1", "Cache-Control": "no-store"})


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
async def render_result(job_id: str, request: Request, part: Optional[int] = None) -> dict:
    _worker(request)
    body = await request.body()
    error = request.headers.get("X-Kairos-Render-Error")
    if len(body) > 60 * 1024 * 1024:
        raise HTTPException(413, "Too large")
    if job_id in design_render_bridge._video_parts:
        return {"ok": await design_render_bridge.complete_video(job_id, body, part, error)}
    return {"ok": design_render_bridge.complete(job_id, body, error)}
