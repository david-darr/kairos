"""Bots attention: inbox, retained notifications and observation panels
(services/bot_attention.py). Admin only, like every Bots route. `/api/notifications`
is device enrollment and stays in notification_routes.py; this is a separate namespace."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core import bot_attention_store as store
from core.middleware import require_admin
from services import bot_attention

router = APIRouter(prefix="/api/bot-attention", tags=["bot-attention"])


class Respond(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(max_length=20)
    expected_revision: str = Field(max_length=100)
    text: str = Field(default="", max_length=8000)
    answers: Optional[dict] = None


class Pin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pinned: bool = True


class ThreadRead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: Optional[str] = Field(default=None, max_length=200)
    ancestry: Optional[list[str]] = Field(default=None, max_length=2000)


@router.get("/inbox")
def inbox(user: str = Depends(require_admin)) -> dict:
    return bot_attention.inbox(user)


@router.post("/inbox/{ident}/read")
def inbox_read(ident: str, user: str = Depends(require_admin)) -> dict:
    bot_attention.inbox_row(user, ident)
    store.set_inbox(user, ident, read=True)
    return {"ok": True}


@router.post("/inbox/{ident}/done")
def inbox_done(ident: str, user: str = Depends(require_admin)) -> dict:
    # Done is a personal filing choice. It never approves or answers anything.
    bot_attention.inbox_row(user, ident)
    store.set_inbox(user, ident, read=True, done=True)
    return {"ok": True}


@router.post("/inbox/{ident}/reopen")
def inbox_reopen(ident: str, user: str = Depends(require_admin)) -> dict:
    bot_attention.inbox_row(user, ident)
    store.set_inbox(user, ident, done=False)
    return {"ok": True}


@router.post("/inbox/{ident}/respond")
def inbox_respond(ident: str, body: Respond, user: str = Depends(require_admin)) -> dict:
    return bot_attention.respond(user, ident, action=body.action, text=body.text,
                                 expected_revision=body.expected_revision, answers=body.answers)


@router.get("/notifications")
def notifications(user: str = Depends(require_admin)) -> dict:
    return bot_attention.notifications(user)


@router.post("/notifications/read-all")
def notifications_read_all(user: str = Depends(require_admin)) -> dict:
    store.read_all(user)
    return {"ok": True}


@router.post("/notifications/{ident}/read")
def notification_read(ident: str, user: str = Depends(require_admin)) -> dict:
    if not store.update_notification(user, ident, read=True):
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.post("/notifications/{ident}/pin")
def notification_pin(ident: str, body: Pin, user: str = Depends(require_admin)) -> dict:
    if not store.update_notification(user, ident, pinned=body.pinned):
        raise HTTPException(404, "Notification not found")
    return {"ok": True}


@router.get("/today")
def today(since: Optional[float] = None, user: str = Depends(require_admin)) -> dict:
    return bot_attention.today(user, since)


@router.get("/needs-you")
def needs_you(user: str = Depends(require_admin)) -> dict:
    return bot_attention.needs_you(user)


@router.get("/bots/{agent_id}/activity")
def activity(agent_id: str, limit: int = 300, user: str = Depends(require_admin)) -> dict:
    return bot_attention.activity(user, agent_id, max(1, min(limit, 400)))


@router.get("/threads/{sid}/events")
def thread_events(sid: str, limit: int = 400, user: str = Depends(require_admin)) -> dict:
    return bot_attention.thread_events(user, sid, max(1, min(limit, 400)))


@router.post("/threads/{sid}/read")
def thread_read(sid: str, body: ThreadRead, user: str = Depends(require_admin)) -> dict:
    """Mark the notifications for a conversation read, once U3 reports what the
    reader actually reached (the selected branch's message IDs)."""
    bot_attention.require_thread(sid, user)
    store.read_thread(user, sid, body.message_id, set(body.ancestry) if body.ancestry is not None else None)
    return {"ok": True}
