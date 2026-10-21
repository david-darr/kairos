"""Authenticated Roblox workspace API; local native control is admin-only."""
import base64
import html
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, Field

from core import tab_api
from core.tab_api import require_user, require_admin
from . import accounts

workspace = tab_api.roblox_workspace
router = APIRouter(prefix="/api/tab-roblox", tags=["roblox"])


class OAuthConfig(BaseModel):
    client_id: str = Field(max_length=200)
    redirect_uri: str = Field(max_length=256)
    client_secret: str | None = Field(default=None, max_length=1000)


class NewProject(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: str = "experiment"
    universe_id: str | None = None
    place_id: str | None = None


class ProjectBrief(BaseModel):
    text: str = Field(max_length=12000)


class Binding(BaseModel):
    studio_id: str = Field(min_length=1, max_length=200)
    allow_edits: bool = False


def checked(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


async def awaited(fn, *args, **kwargs):
    try:
        return await fn(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, TimeoutError):
        raise HTTPException(502, "Studio could not be reached. Open Studio, enable its MCP server, then retry.")
    except Exception:
        raise HTTPException(502, "The Studio connection failed. Update Studio, enable its MCP server, and reconnect the project.")


@router.get("/status")
def status(user: str = Depends(require_user)):
    return {"account": accounts.status(user), "studio": workspace.status(),
            "admin": tab_api.is_admin(user)}


@router.get("/oauth/config")
def oauth_config(user: str = Depends(require_admin)):
    return accounts.safe_config()


@router.put("/oauth/config")
def set_oauth_config(body: OAuthConfig, user: str = Depends(require_admin)):
    return checked(accounts.configure, body.client_id, body.redirect_uri, body.client_secret)


@router.post("/oauth/start")
def oauth_start(user: str = Depends(require_user)):
    return {"url": checked(accounts.start, user)}


@router.get("/oauth/callback", response_class=HTMLResponse)
async def oauth_callback(state: str = "", code: str = "", error: str | None = None):
    try:
        await accounts.callback(state, code, error)
        message, status_code = "Roblox connected. Return to Kairos and refresh the Roblox workspace.", 200
    except ValueError as exc:
        message, status_code = str(exc), 400
    return HTMLResponse("<!doctype html><html><head><meta name=\"referrer\" content=\"no-referrer\"><title>Roblox connection</title></head>"
        "<body><h1>Roblox connection</h1><p>" + html.escape(message) + "</p></body></html>", status_code=status_code,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.delete("/account")
async def disconnect_account(user: str = Depends(require_user)):
    return await accounts.disconnect(user)


@router.get("/library")
async def library(user: str = Depends(require_user)):
    return await awaited(accounts.library, user)


@router.get("/projects")
def projects(user: str = Depends(require_user)):
    return workspace.projects(user)


@router.post("/projects")
def create(body: NewProject, user: str = Depends(require_user)):
    return checked(workspace.create, user, body.name, body.kind, body.universe_id, body.place_id,
                   (accounts.status(user).get("profile") or {}).get("sub", "local"))


@router.get("/projects/{pid}")
def project(pid: str, user: str = Depends(require_user)):
    return workspace.public(checked(workspace.project, user, pid))


@router.put("/projects/{pid}/brief")
def brief(pid: str, body: ProjectBrief, user: str = Depends(require_user)):
    return checked(workspace.brief, user, pid, body.text)


@router.post("/projects/{pid}/session")
def session(pid: str, user: str = Depends(require_user)):
    return {"session_id": checked(workspace.chat, user, pid)}


@router.post("/projects/{pid}/place-copy")
async def place_copy(pid: str, file: UploadFile, user: str = Depends(require_user)):
    checked(workspace.project, user, pid)
    content = await file.read(50 * 1024 * 1024 + 1)
    return checked(workspace.save_place, user, pid, file.filename or "", content)


@router.get("/projects/{pid}/files")
def files(pid: str, user: str = Depends(require_user)):
    checked(workspace.project, user, pid)
    return [{"name": p.name, "size": p.stat().st_size} for p in workspace.folder(pid).iterdir()
            if p.is_file() and not p.is_symlink() and (p.suffix in {".rbxl", ".rbxlx", ".json"})]


@router.get("/projects/{pid}/files/{name}")
def download(pid: str, name: str, user: str = Depends(require_user)):
    checked(workspace.project, user, pid)
    if name != Path(name).name or "/" in name or "\\" in name or name not in {f["name"] for f in files(pid, user)}:
        raise HTTPException(404, "File not found")
    return FileResponse(workspace._safe(workspace.folder(pid) / name), filename=name)


@router.get("/studios")
async def studios(user: str = Depends(require_admin)):
    return await awaited(workspace.studios)


@router.post("/projects/{pid}/open")
async def open_project(pid: str, user: str = Depends(require_admin)):
    return await awaited(workspace.open_existing_or_launch, user, pid)


@router.get("/projects/{pid}/connection")
async def connection(pid: str, user: str = Depends(require_admin)):
    return await awaited(workspace.connection, user, pid)


@router.put("/projects/{pid}/studio")
async def bind(pid: str, body: Binding, user: str = Depends(require_admin)):
    return await awaited(workspace.bind, user, pid, body.studio_id, body.allow_edits)


@router.delete("/projects/{pid}/studio")
def unbind(pid: str, user: str = Depends(require_admin)):
    return checked(workspace.unbind, user, pid)


@router.post("/projects/{pid}/viewport")
async def viewport(pid: str, user: str = Depends(require_admin)):
    row = checked(workspace.project, user, pid)
    if not row.get("session_id"):
        raise HTTPException(400, "Open the project chat first")
    answer = await awaited(workspace.tool, row["session_id"], "call", "screen_capture", {}, is_admin=True)
    return {"text": answer["text"], "images": [base64.b64encode(image).decode() for image in answer["images"]]}


class StyleChange(BaseModel):
    action: str
    entry_id: str | None = None
    category: str = "ui"
    key: str = ""
    value: str = ""
    locked: bool = False
    learning: bool | None = None
    revision: int | None = None
    project_only: bool = False
    preset: str = "default"


@router.get("/projects/{pid}/style")
def style(pid: str, user: str = Depends(require_user)):
    return checked(tab_api.roblox_style.get, user, pid)


@router.put("/projects/{pid}/style")
def style_change(pid: str, body: StyleChange, user: str = Depends(require_user)):
    checked(workspace.ensure_idle, checked(workspace.project, user, pid))
    if body.action == "preset":
        return checked(tab_api.roblox_style.select, user, pid, body.preset)
    return checked(tab_api.roblox_style.change, user, pid, **body.model_dump(exclude={"preset"}))


@router.get("/projects/{pid}/assets")
def assets(pid: str, user: str = Depends(require_user)):
    return checked(tab_api.roblox_assets.listing, user, pid)
