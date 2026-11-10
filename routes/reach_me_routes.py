"""Settings > Reach me: where the signed-in account's bots message and call the person (core/reach_me.py). Everything
here belongs to the caller's own account; nothing names another account."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import reach_me
from core.middleware import require_user
from services import reach_me as reach_service

router = APIRouter(prefix="/api/reach-me", tags=["reach-me"])


class QuietBody(BaseModel):
    enabled: bool = False
    start: str = Field(default="22:00", max_length=5)
    end: str = Field(default="07:00", max_length=5)


class ReachBody(BaseModel):
    message: Optional[list[str]] = Field(default=None, max_length=len(reach_me.MESSAGE_CHANNELS))
    call: Optional[list[str]] = Field(default=None, max_length=len(reach_me.CALL_CHANNELS))
    quiet: Optional[QuietBody] = None
    bots: Optional[dict[str, dict[str, Optional[list[str]]]]] = Field(default=None, max_length=200)


class PauseBody(BaseModel):
    paused: bool


@router.get("")
async def get_reach_me(user: str = Depends(require_user)) -> dict:
    return reach_service.view()


@router.put("")
async def save_reach_me(body: ReachBody, user: str = Depends(require_user)) -> dict:
    patch = body.model_dump(exclude_unset=True)
    try:
        reach_me.save(patch)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    return reach_service.view()


@router.post("/pause")
async def pause_reach_me(body: PauseBody, user: str = Depends(require_user)) -> dict:
    """The switch in Settings: the same pause a STOP reply makes, and the same resume as START."""
    (reach_me.pause if body.paused else reach_me.resume)("settings", by="settings")
    return reach_service.view()
