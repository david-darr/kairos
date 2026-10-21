"""Private creative accounts and explicit per-chat/bot access."""
import html

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from core import addons

class _Creative:
    def __getattr__(self, name):
        return getattr(addons.module('creative_tools'), name)

creative_tools = _Creative()

def active(request: Request):
    parts = request.url.path.removeprefix('/api/creative').strip('/').split('/')
    provider = parts[0]
    if provider in {'blender', 'higgsfield'} and not addons.enabled(provider):
        raise HTTPException(409, 'Install and enable this add-on in Tool Store first')
    if provider == 'oauth' and not addons.enabled('higgsfield'):
        raise HTTPException(409, 'Higgsfield add-on is disabled')
from core.middleware import require_user, require_admin, local_api_base
from core.auth import auth_manager

router = APIRouter(prefix="/api/creative", tags=["creative"], dependencies=[Depends(active)])


def checked(fn, *args, **kwargs):
    try: return fn(*args, **kwargs)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc


async def awaited(fn, *args, **kwargs):
    try: return await fn(*args, **kwargs)
    except ValueError as exc: raise HTTPException(400, str(exc)) from exc
    except Exception: raise HTTPException(502, "Creative service unavailable. Check the connection before retrying.")


@router.get("")
def catalog(user: str = Depends(require_user)):
    return creative_tools.catalog(user) if addons.enabled('_creative') else []


class Pairing(BaseModel):
    port: int = Field(ge=1024, le=65535)
    token: str = Field(min_length=20, max_length=200)


@router.post("/blender")
def blender(body: Pairing, user: str = Depends(require_admin)):
    checked(creative_tools.connect_blender, user, body.port, body.token)
    return creative_tools.catalog(user)


@router.get("/blender/addon")
def addon(user: str = Depends(require_admin)):
    return FileResponse(addons.file('blender', 'desktop/kairos_blender.py'),
                        filename="kairos_blender.py", media_type="text/x-python")


@router.post("/higgsfield/sign-in")
async def sign_in(user: str = Depends(require_user)):
    return await awaited(creative_tools.sign_in, user, local_api_base() + "/creative/oauth/callback")


@router.get("/oauth/callback")
async def callback(state: str = "", code: str = "", iss: str | None = None, error: str | None = None):
    try:
        await creative_tools.callback(state, code, iss, error)
        message, status = "Higgsfield connected. Return to Kairos and check its tools.", 200
    except ValueError as exc: message, status = str(exc), 400
    return HTMLResponse("<!doctype html><title>Creative connection</title><p>" + html.escape(message) + "</p>",
                        status_code=status, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


def scope(user, session_id, agent_id):
    if bool(session_id) == bool(agent_id): raise HTTPException(400, "Choose one chat or bot")
    if agent_id and not auth_manager.is_admin(user): raise HTTPException(403, "Bot access requires an administrator")
    return dict(sid=session_id, agent_id=agent_id)


@router.get("/selection")
def selection(session_id: str | None = None, agent_id: str | None = None, user: str = Depends(require_user)):
    if not addons.enabled('_creative'): return {'connections': [], 'selected': []}
    return checked(creative_tools.choices, user, **scope(user, session_id, agent_id))


class Selection(BaseModel):
    providers: list[str]


@router.put("/selection")
def select(body: Selection, session_id: str | None = None, agent_id: str | None = None, user: str = Depends(require_user)):
    if not addons.enabled('_creative'): raise HTTPException(409, 'Install a creative add-on in Tool Store first')
    return checked(creative_tools.select, user, body.providers, **scope(user, session_id, agent_id))


@router.get("/jobs")
def jobs(user: str = Depends(require_user)):
    return creative_tools.jobs(user) if addons.enabled('_creative') else []


@router.post("/jobs/{job_id}/reviewed")
def reviewed(job_id: str, user: str = Depends(require_user)):
    if not addons.enabled('_creative'): raise HTTPException(409, 'Creative add-ons are disabled')
    checked(creative_tools.resolve_job, user, job_id)
    return creative_tools.jobs(user)


class Check(BaseModel):
    accept: bool = False


@router.post("/{provider}/check")
async def check(provider: str, body: Check, user: str = Depends(require_user)):
    if provider == "blender" and not auth_manager.is_admin(user): raise HTTPException(403, "Native Blender requires an administrator")
    return await awaited(creative_tools.check, user, provider, body.accept)


@router.delete("/{provider}")
def disconnect(provider: str, user: str = Depends(require_user)):
    checked(creative_tools.disconnect, user, provider)
    return creative_tools.catalog(user)


@router.get("/higgsfield/review")
def review(user: str = Depends(require_user)):
    row = creative_tools._account(user, "higgsfield")
    return {"tools": row.get("tools", []), "held_tools": row.get("held_tools", [])}
