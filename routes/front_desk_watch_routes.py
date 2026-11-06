"""Watch, brief and person-operated saved draft actions."""
import asyncio
from typing import Annotated
from zoneinfo import ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from services import front_desk_watch as watch, front_desk_brief as brief, front_desk_drafts as drafts

router = APIRouter(prefix="/api/front-desk", tags=["front-desk-watch"])


def owner(user: str = Depends(require_user)):
    watch.require_owner(user)
    return user


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    morning_on: bool | None = None
    morning_time: Annotated[str, Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")] | None = None


class Presence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    zone: str = Field(min_length=1, max_length=100)
    language: str = Field(default="en", min_length=2, max_length=20, pattern=r"^[A-Za-z-]+$")


def problem(error):
    if isinstance(error, KeyError):
        raise HTTPException(404, "Item not found") from error
    raise HTTPException(409, str(error)) from error


@router.get("/watch")
async def get_watch(user: str = Depends(owner)):
    return await asyncio.to_thread(watch.state)


@router.post("/watch/run-now")
async def run_now(user: str = Depends(owner)):
    try:
        return await asyncio.to_thread(watch.run_now)
    except ValueError as error:
        problem(error)


@router.patch("/watch/settings")
def settings(body: Settings, user: str = Depends(owner)):
    return watch.settings(**body.model_dump(exclude_none=True))


@router.get("/brief")
async def get_brief(user: str = Depends(owner)):
    return await brief.refresh("open")


@router.get("/today")
async def get_today(user: str = Depends(owner)):
    """The brief's sections for the desktop Today panel, read only: nothing is posted to the chat."""
    return await brief.refresh("today", post=False)


@router.post("/presence")
async def presence(body: Presence, user: str = Depends(owner)):
    try:
        return await brief.presence(body.zone, body.language)
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(422, "Choose a valid time zone") from None


@router.get("/drafts")
def get_drafts(user: str = Depends(owner)):
    return {"drafts": drafts.list_drafts()}


@router.post("/brief/rows/{ident}/dismiss")
async def dismiss(ident: str, user: str = Depends(owner)):
    try:
        return await brief.dismiss(ident)
    except (KeyError, ValueError) as error:
        problem(error)


@router.post("/brief/rows/{ident}/draft")
async def draft(ident: str, user: str = Depends(owner)):
    try:
        return await brief.draft(ident)
    except (KeyError, ValueError) as error:
        problem(error)


@router.post("/drafts/{ident}/send")
async def send_draft(ident: str, user: str = Depends(owner)):
    try:
        return await drafts.send(ident, user)
    except (KeyError, ValueError) as error:
        problem(error)


@router.delete("/drafts/{ident}")
def discard_draft(ident: str, user: str = Depends(owner)):
    try:
        return drafts.discard(ident)
    except (KeyError, ValueError) as error:
        problem(error)
