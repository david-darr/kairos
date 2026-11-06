"""Onboarding belongs to the authenticated person, never a request owner field."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from core.middleware import require_user
from services import bot_onboarding as onboarding

router = APIRouter(prefix="/api/bot-onboarding", tags=["bot-onboarding"], dependencies=[Depends(require_user)])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Tour(Body):
    done: StrictBool | None = None
    step: int | None = Field(default=None, ge=0, le=10, strict=True)
    variant: Literal["simple", "advanced"] | None = None


class Notice(Body):
    dismissed: StrictBool


class Patch(Body):
    welcome_seen: StrictBool | None = None
    tour: Tour | None = None
    hints: list[str] | None = Field(default=None, max_length=200)
    notices: dict[str, Notice] | None = Field(default=None, max_length=100)


@router.get("")
def state(user: str = Depends(require_user)):
    return onboarding.state(user)


@router.patch("")
def patch(body: Patch, user: str = Depends(require_user)):
    try:
        return onboarding.patch(user, body.model_dump(exclude_none=True))
    except onboarding.OnboardingError as error:
        raise HTTPException(error.status, str(error)) from None


@router.get("/setup")
async def setup(user: str = Depends(require_user)):
    return await onboarding.setup(user)


@router.post("/setup/recheck")
async def recheck(user: str = Depends(require_user)):
    try:
        return await onboarding.setup(user, recheck=True)
    except onboarding.OnboardingError as error:
        raise HTTPException(error.status, str(error), headers={"Retry-After": "10"}) from None
