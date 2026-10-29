"""Bots widgets and apps routes (services/bot_widgets.py, services/bot_apps.py). Admin only.

The session comes from the path and is checked against the caller; the bot is the session's own."""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_admin
from services import bot_apps, bot_widgets
from services.bot_widgets import WidgetError

router = APIRouter(prefix="/api/bot-widgets", tags=["bot-widgets"])


class Press(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: str = Field(max_length=80)
    ref: str = Field(max_length=60)
    rev: int = Field(ge=1, le=1_000_000)
    values: dict = Field(default_factory=dict)
    other: Optional[dict] = None
    send_id: str = Field(min_length=8, max_length=100)


class Rpc(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: str = Field(max_length=60)
    params: dict = Field(default_factory=dict)


class Context(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Optional[str] = Field(default=None, max_length=bot_apps.MAX_ARGS_BYTES)


def _fail(error: WidgetError) -> JSONResponse:
    return JSONResponse({"detail": str(error)}, status_code=error.status)


@router.post("/{sid}/press")
async def press(sid: str, body: Press, user: str = Depends(require_admin)):
    try:
        return await bot_widgets.press(user, sid, body.model_dump())
    except WidgetError as error:
        return _fail(error)


@router.get("/{sid}/apps/{mid}")
def app_page(sid: str, mid: str, rev: Optional[int] = Query(default=None, ge=1, le=1_000_000), user: str = Depends(require_admin)):
    from services import bot_chat_service
    bot_chat_service.require(user, sid)
    try:
        return bot_apps.get(sid, mid, rev)
    except WidgetError as error:
        return _fail(error)


@router.get("/{sid}/apps/{mid}/frame")
def app_frame(sid: str, mid: str, channel: str = Query(pattern=r"^[A-Za-z0-9_-]{4,40}$"),
              rev: Optional[int] = Query(default=None, ge=1, le=1_000_000), user: str = Depends(require_admin)):
    """The page itself, for the sandboxed frame's address. It carries its own policy as a header (plus `sandbox`, so
    it stays sandboxed if opened on its own). X-Kairos-Design-Render asks core/middleware.py to keep this policy
    instead of the app's: the same exemption a Design board uses."""
    from services import bot_chat_service
    bot_chat_service.require(user, sid)
    try:
        page = bot_apps.get(sid, mid, rev)
    except WidgetError as error:
        return _fail(error)
    document = bot_apps.frame_document(page["html"], page["csp"], channel)
    return HTMLResponse(document, headers={"Content-Security-Policy": page["csp"] + "; sandbox " + bot_apps.SANDBOX.replace("allow-", "allow-"),
                                           "X-Kairos-Design-Render": "1", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/{sid}/apps/{mid}/rpc")
async def app_rpc(sid: str, mid: str, body: Rpc, user: str = Depends(require_admin)):
    try:
        return await bot_apps.rpc(user, sid, mid, body.model_dump())
    except WidgetError as error:
        return _fail(error)


@router.post("/{sid}/apps/{mid}/context")
def app_context(sid: str, mid: str, body: Context, user: str = Depends(require_admin)):
    try:
        return bot_apps.set_page_context(user, sid, mid, body.model_dump())
    except WidgetError as error:
        return _fail(error)
