"""Recall, forget, About you and Memory activity (Bots Phase 2, unit U2). Mounted by the aggregate
routes/bot_resources_routes.py under /api/bots. Admin only; the owner is the signed-in account, never a body field.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_admin
from services import bot_memory_recall, bot_memory_upkeep, bot_profile, bot_turn_context as ctx
from services.agent_service import agent_service

router = APIRouter(prefix="/api/bots", tags=["bot-recall"])


class ForgetBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str = Field(max_length=60)


class AboutBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=bot_profile.ABOUT_LIMIT + 1)
    expected_hash: Optional[str] = Field(default=None, max_length=100)


def _fail(error: Exception) -> HTTPException:
    return HTTPException(getattr(error, "status", 400), str(error))


def _bot(bot_id: str) -> dict:
    bot = agent_service.get(bot_id)
    if bot is None:
        raise HTTPException(404, "bot not found")
    return bot


def _scope(bot_id: str, user: str) -> dict:
    _bot(bot_id)
    return {"bot_id": bot_id, "owner": user}


# -- About you (static routes first) ---------------------------------------------------------------------------

@router.get("/profile")
def get_profile(user: str = Depends(require_admin)) -> dict:
    try:
        return {**bot_profile.get_about(user), "learned": bot_profile.learned(user),
                "limits": {"learned": bot_profile.MAX_LEARNED}}
    except bot_profile.ProfileError as error:
        raise _fail(error)


@router.put("/profile")
def put_profile(body: AboutBody, user: str = Depends(require_admin)) -> dict:
    try:
        return bot_profile.put_about(user, body.text, body.expected_hash)
    except bot_profile.ProfileError as error:
        raise _fail(error)


@router.post("/profile/learned/{fact}/remove")
def remove_learned(fact: str, user: str = Depends(require_admin)) -> dict:
    try:
        return bot_profile.remove_learned(user, fact)
    except bot_profile.ProfileError as error:
        raise _fail(error)


# -- recall ----------------------------------------------------------------------------------------------------

@router.get("/{bot_id}/recall")
def recall(bot_id: str, q: Optional[str] = Query(default=None, max_length=600), since: Optional[str] = Query(default=None, max_length=40),
           until: Optional[str] = Query(default=None, max_length=40), kind: str = Query(default="all", max_length=20),
           limit: int = Query(default=bot_memory_recall.SEARCH_DEFAULT, ge=1, le=bot_memory_recall.SEARCH_MAX),
           user: str = Depends(require_admin)) -> dict:
    scope = _scope(bot_id, user)
    if not ctx.bot_flags(bot_id)["memory"]:
        return {"results": [], "count": 0, "disabled": True}
    try:
        return bot_memory_recall.search(scope, q=q, since=since, until=until, kind=kind, limit=limit)
    except bot_memory_recall.RecallError as error:
        raise _fail(error)


@router.get("/{bot_id}/recall/messages/{message}")
def recall_message(bot_id: str, message: str, user: str = Depends(require_admin)) -> dict:
    scope = _scope(bot_id, user)
    try:
        return bot_memory_recall.read_message(scope, message)
    except bot_memory_recall.RecallError as error:
        raise _fail(error)


# -- forget and activity -----------------------------------------------------------------------------------------

@router.post("/{bot_id}/memory/forget")
async def forget(bot_id: str, body: ForgetBody, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        result = bot_memory_upkeep.forget(bot_id, user, body.term)
    except bot_profile.ProfileError as error:
        raise _fail(error)
    from services import chat_service
    await chat_service.reset_resumed_sessions(bot_id)
    return result


@router.get("/{bot_id}/memory/activity")
def activity(bot_id: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    return bot_memory_upkeep.status(bot_id)
