"""Bot approval levels over HTTP (Bots redesign, Phase 3 unit U1, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 4.1, 5.1, 5.2 and 6.

These routes carry complete absolute prefixes and are added to routes/permission_routes.py's router, so
they do not nest. Every management route needs an admin, and a conversation id must belong to the bot
and to the caller; anything else answers 404. Bodies forbid extra fields and are bounded.

Raising the level is not an ordinary write. The page asks to prepare it (POST .../elevate); only the
desktop shell, holding a secret the page never sees, can confirm, activate and commit it through
/api/internal/bots-approvals/{step}. A model's tool token is refused there outright.
"""
import os
import secrets
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from core import bot_outbound, bot_policy, permissions
from core.middleware import require_admin

router = APIRouter(tags=["bot-approvals"])

# Taken out of the environment at import, like the UI secret, so a process the backend starts never
# inherits it. None means no desktop shell is attached: the handshake cannot complete.
DESKTOP_SECRET: Optional[str] = os.environ.pop("JARVIS_DESKTOP_SECRET", None) or None
DESKTOP_HEADER = "X-Kairos-Desktop"

Id = Annotated[str, Field(min_length=1, max_length=80)]


class ModeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Optional[Literal["ask", "edits", "auto", "full", "custom"]] = None
    scope: Literal["bot", "thread", "all_threads"] = "bot"
    thread_id: Optional[Id] = None
    expected_revision: Optional[int] = Field(default=None, ge=0)


class ElevateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["edits", "auto", "full", "custom"]
    scope: Literal["bot", "thread"] = "bot"
    thread_id: Optional[Id] = None
    expected_revision: Optional[int] = Field(default=None, ge=0)


class StepBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Id
    bot_id: Optional[Id] = None
    thread_id: Optional[Id] = None
    mode: Optional[Literal["edits", "auto", "full", "custom"]] = None
    revision: Optional[int] = Field(default=None, ge=0)


class RuleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Id


def _fail(error: Exception):
    status = getattr(error, "status", 400)
    return HTTPException(status, str(error))


def _bot(bot_id: str) -> dict:
    agent = bot_policy._agent(bot_id)
    if agent is None:
        raise HTTPException(404, "No such bot.")
    return agent


@router.get("/api/bots-approvals/{bot_id}")
async def get_policy(bot_id: str, thread_id: Optional[str] = Query(default=None, max_length=80),
                     user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        return bot_policy.view(bot_id, thread_id, user)
    except bot_policy.PolicyError as error:
        raise _fail(error)


@router.post("/api/bots-approvals/{bot_id}/mode")
async def set_mode(bot_id: str, body: ModeBody, user: str = Depends(require_admin)) -> dict:
    """Lower the level, or set one that is not higher. Raising goes through .../elevate."""
    _bot(bot_id)
    try:
        return bot_policy.change_mode(bot_id, body.mode, scope=body.scope, thread_id=body.thread_id,
                                      expected_revision=body.expected_revision, user=user)
    except bot_policy.PolicyError as error:
        raise _fail(error)
    except ValueError as error:
        raise HTTPException(409 if type(error).__name__ == "BotConflict" else 400, str(error))


@router.post("/api/bots-approvals/{bot_id}/elevate")
async def prepare_elevation(bot_id: str, body: ElevateBody, user: str = Depends(require_admin)) -> dict:
    """Step one of raising the level. Changes nothing; the desktop shell finishes it."""
    _bot(bot_id)
    try:
        return bot_policy.prepare_elevation(bot_id, body.mode, scope=body.scope, thread_id=body.thread_id,
                                            expected_revision=body.expected_revision, user=user)
    except bot_policy.PolicyError as error:
        raise _fail(error)


def _desktop_only(request: Request) -> None:
    if not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "This is reachable only from this computer.")
    if request.headers.get("X-JARVIS-Tool-Token"):
        raise HTTPException(403, "A model's tool access cannot do this.")
    supplied = request.headers.get(DESKTOP_HEADER, "")
    if not DESKTOP_SECRET or not supplied or not secrets.compare_digest(supplied, DESKTOP_SECRET):
        raise HTTPException(404, "Not found.")


@router.post("/api/internal/bots-approvals/{step}", dependencies=[Depends(_desktop_only)])
async def desktop_step(step: Literal["confirm", "activate", "commit", "revoke"], body: StepBody,
                       request: Request) -> dict:
    try:
        if step == "revoke":
            return {"revoked": bot_policy.revoke_elevation(body.request_id)}
        if body.bot_id is None or body.mode is None or body.revision is None:
            raise HTTPException(400, "bot_id, mode and revision are required.")
        function = {"confirm": bot_policy.confirm_elevation, "activate": bot_policy.activate_elevation,
                    "commit": bot_policy.commit_elevation}[step]
        return function(body.request_id, body.bot_id, body.thread_id, body.mode, body.revision)
    except bot_policy.PolicyError as error:
        raise _fail(error)
    except ValueError as error:
        bot_policy.revoke_elevation(body.request_id)
        raise HTTPException(409, str(error))


@router.get("/api/bots-approvals/{bot_id}/commands")
async def list_commands(bot_id: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    return {"rules": bot_policy.list_command_rules(bot_id), "limit": bot_policy.MAX_COMMAND_RULES,
            "state_corrupt": bot_policy.state_corrupt()}


@router.post("/api/bots-approvals/{bot_id}/commands")
async def add_command(bot_id: str, body: RuleBody, user: str = Depends(require_admin)) -> dict:
    """Remember the exact command a live request is asking about. There is no way to write a rule from
    nothing: it must belong to a request that is waiting right now, for this bot."""
    _bot(bot_id)
    pending = permissions.pending_request(body.request_id)
    meta = (pending.bot if pending else None) or {}
    if not pending or meta.get("bot_id") != bot_id or not meta.get("command"):
        raise HTTPException(404, "That request is not waiting for an answer.")
    if meta.get("thread_id"):
        try:
            bot_policy._owned_thread(bot_id, meta["thread_id"], user)
        except bot_policy.PolicyError:
            raise HTTPException(404, "That request is not waiting for an answer.")
    try:
        rule = bot_policy.add_command_rule(bot_id, meta["command"], meta.get("cwd"), meta.get("provider"), by=user,
                                           request_id=body.request_id)
    except bot_policy.PolicyError as error:
        raise _fail(error)
    return {"rule": rule}


@router.delete("/api/bots-approvals/{bot_id}/commands/{rule_id}")
async def delete_command(bot_id: str, rule_id: str, user: str = Depends(require_admin)) -> dict:
    _bot(bot_id)
    try:
        removed = bot_policy.delete_command_rule(bot_id, rule_id)
    except bot_policy.PolicyError as error:
        raise _fail(error)
    if not removed:
        raise HTTPException(404, "No such rule.")
    return {"status": "removed"}


@router.get("/api/bots-approvals/{bot_id}/outbound")
async def get_outbound(bot_id: str, user: str = Depends(require_admin)) -> dict:
    agent = _bot(bot_id)
    outbound = agent.get("outbound") or {"policy": "ask", "daily_cap": 25}
    cap = int(outbound.get("daily_cap") or 25)
    return {"policy": outbound.get("policy", "ask"), **bot_outbound.usage(user, bot_id, cap)}


def _decision_rows(user: str, bot_id: Optional[str], thread_id: Optional[str], since: Optional[float],
                   limit: int) -> list[dict]:
    return bot_policy.decisions(user, bot_id=bot_id, thread_id=thread_id, since=since, limit=limit)


@router.get("/api/bot-decisions")
async def get_decisions(bot_id: Optional[str] = Query(default=None, max_length=80),
                        thread_id: Optional[str] = Query(default=None, max_length=80),
                        since: Optional[float] = Query(default=None, ge=0),
                        limit: int = Query(default=200, ge=1, le=1000),
                        user: str = Depends(require_admin)) -> dict:
    return {"decisions": _decision_rows(user, bot_id, thread_id, since, limit),
            "retention_days": bot_policy.DECISION_RETENTION_DAYS}


@router.get("/api/bot-decisions.csv")
async def get_decisions_csv(bot_id: Optional[str] = Query(default=None, max_length=80),
                            thread_id: Optional[str] = Query(default=None, max_length=80),
                            since: Optional[float] = Query(default=None, ge=0),
                            limit: int = Query(default=1000, ge=1, le=1000),
                            user: str = Depends(require_admin)) -> PlainTextResponse:
    text = bot_policy.decisions_csv(_decision_rows(user, bot_id, thread_id, since, limit))
    return PlainTextResponse(text, media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="bot-decisions.csv"'})
