"""Rings: the person's side of a bot ringing them inside Kairos (services/rings.py). Each user sees only their own account's rings."""
import logging

from fastapi import APIRouter, Depends, Path

from core import accounts
from core.middleware import require_user
from services import rings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/rings", tags=["rings"])
_ID = Path(pattern="^[0-9a-f]{32}$")


@router.get("/pending")
async def pending(user: str = Depends(require_user)):
    """The rings ringing for this user, and how many calls to other people are going (`outbound`), so the window's
    outbound call panel needs no poll of its own while none is (static/js/outboundCallHost.js, 2026-11-09)."""
    account = accounts.effective_account()
    reply = {"rings": rings.pending(account, user)}
    try:
        from services import outbound_calls
        reply["outbound"] = len(outbound_calls.active(account))
    except Exception:   # the panel then polls for itself (an unknown count reads as "look")
        logger.exception("outbound calls could not be counted for the ring poll")
    return reply


@router.post("/{ring_id}/answer")
async def answer(ring_id: str = _ID, via: str = "", user: str = Depends(require_user)):
    """`via=link`: the push notification's Answer or its deep link, which answers only a call still ringing."""
    return rings.answer(accounts.effective_account(), user, ring_id, via_link=via == "link")


@router.post("/{ring_id}/decline")
async def decline(ring_id: str = _ID, user: str = Depends(require_user)):
    return rings.decline(accounts.effective_account(), user, ring_id)
