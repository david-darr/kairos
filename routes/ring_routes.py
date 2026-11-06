"""Rings: the person's side of a bot ringing them inside Kairos (services/rings.py). Each user sees only their own account's rings."""
from fastapi import APIRouter, Depends, Path

from core import accounts
from core.middleware import require_user
from services import rings

router = APIRouter(prefix="/api/rings", tags=["rings"])
_ID = Path(pattern="^[0-9a-f]{32}$")


@router.get("/pending")
async def pending(user: str = Depends(require_user)):
    return {"rings": rings.pending(accounts.effective_account(), user)}


@router.post("/{ring_id}/answer")
async def answer(ring_id: str = _ID, user: str = Depends(require_user)):
    return rings.answer(accounts.effective_account(), user, ring_id)


@router.post("/{ring_id}/decline")
async def decline(ring_id: str = _ID, user: str = Depends(require_user)):
    return rings.decline(accounts.effective_account(), user, ring_id)
