"""Admin workbench endpoints. No client paths or owner identities are accepted."""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from core.middleware import require_admin
from services import bot_workbench as workbench, bot_browser_profiles as profiles, bot_help

router = APIRouter(prefix="/api/bot-workbench", tags=["bot-workbench"], dependencies=[Depends(require_admin)])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Name(Body):
    name: str = Field(min_length=1, max_length=60)


class Limits(Body):
    max_running: int = Field(ge=1, le=8, strict=True)
    idle_minutes: int = Field(ge=5, le=1440, strict=True)


class Control(Body):
    action: Literal["take", "release"]
    lease_id: str | None = Field(default=None, max_length=64)


class Browser(Body):
    enabled: StrictBool | None = None
    profile: str | None = Field(default=None, pattern=r"^(own|guest|shared:[0-9a-f]{12})$")


class Site(Body):
    host: str = Field(min_length=1, max_length=253)


class Settle(Body):
    outcome: Literal["done", "cancel"]


def agent(bot_id, thread_id=None, user=None):
    from services.agent_service import agent_service
    result = agent_service.get(bot_id)
    if result is None:
        raise HTTPException(404, "Bot not found")
    if thread_id:
        try:
            session = workbench.thread_for(result, thread_id)
        except KeyError:
            raise HTTPException(404, "Conversation not found") from None
        if user and session.get("owner_user") and session["owner_user"] != user:
            raise HTTPException(404, "Conversation not found")
    return result


def change(fn, *args):
    try:
        return fn(*args)
    except KeyError:
        raise HTTPException(404, "Not found") from None
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


@router.get("/profiles")
def list_profiles():
    return profiles.list_profiles()


@router.post("/profiles")
def create_profile(body: Name):
    return change(profiles.create, body.name)


@router.patch("/profiles/{profile_id}")
def rename_profile(profile_id: str, body: Name):
    return change(profiles.rename, profile_id, body.name)


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    change(profiles.delete, profile_id)
    return {"ok": True}


@router.get("/computers")
async def computers():
    return await workbench.inventory()


@router.put("/computers/settings")
def computer_settings(body: Limits):
    return workbench.set_computer_settings(body.max_running, body.idle_minutes)


@router.get("/{bot_id}/status")
async def status(bot_id: str, thread_id: str | None = Query(default=None, max_length=80), user=Depends(require_admin)):
    return await workbench.status(agent(bot_id, thread_id, user), thread_id)


@router.post("/{bot_id}/computer/start")
async def start(bot_id: str, thread_id: str | None = Query(default=None, max_length=80), user=Depends(require_admin)):
    bot = agent(bot_id, thread_id, user)
    try:
        await workbench.start(bot, thread_id)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from None
    return {"ok": True}


@router.post("/{bot_id}/computer/sleep")
async def sleep(bot_id: str):
    from core import computer
    agent(bot_id)
    await computer.manager.stop("agent:" + bot_id)
    return {"ok": True}


@router.post("/{bot_id}/computer/control")
def control(bot_id: str, body: Control):
    agent(bot_id)
    return change(workbench.control, bot_id, body.action, body.lease_id)


@router.get("/{bot_id}/places")
async def places(bot_id: str):
    return await workbench.places(agent(bot_id))


@router.get("/{bot_id}/files")
async def files(bot_id: str, thread_id: str | None = Query(default=None, max_length=80), user=Depends(require_admin)):
    bot = agent(bot_id, thread_id, user)
    return await asyncio.to_thread(workbench.files, bot, thread_id, user)


@router.get("/{bot_id}/sites")
async def sites(bot_id: str):
    return await asyncio.to_thread(profiles.sites, agent(bot_id))


@router.post("/{bot_id}/sites/sign-out")
async def sign_out(bot_id: str, body: Site):
    try:
        await profiles.sign_out(agent(bot_id), body.host)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    return {"ok": True}


@router.put("/{bot_id}/browser")
async def browser(bot_id: str, body: Browser):
    from core import computer
    from services.agent_service import agent_service
    bot = agent(bot_id)
    fields = {}
    if body.profile is not None:
        change(profiles.resolve, {**bot, "browser_profile": body.profile})
        fields["browser_profile"] = body.profile
    if body.enabled is not None:
        fields["browser_enabled"] = body.enabled
    # A live computer must never retain a partition after the person changes it.
    async with computer.manager._lock:
        await computer.manager._stop("agent:" + bot_id)
        result = agent_service.update(bot_id, **fields)
    return {"enabled": result.get("browser_enabled", True), "profile": result.get("browser_profile", "own")}


@router.post("/{bot_id}/help/{help_id}/settle")
def settle(bot_id: str, help_id: str, body: Settle):
    agent(bot_id)
    return change(bot_help.settle_help, bot_id, help_id, body.outcome)
