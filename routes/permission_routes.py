"""Answering, listing and revoking permission requests.

Answering is a normal user action - it is the person's own prompt. Revoking a
saved rule is admin-gated like the other settings that change what models may
do, because a rule is global to this install rather than to one chat.

There is no route that creates a rule directly. A grant only ever comes from
answering a real request, so nothing can be granted that was never asked for.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from core import cli_access, permissions
from core.middleware import require_admin, require_user
from services import chat_live

router = APIRouter(prefix="/api/permissions", tags=["permissions"])


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    choice: Annotated[str, Field(min_length=1, max_length=40)]


@router.get("")
async def list_permissions(user: str = Depends(require_user)) -> dict:
    from core.auth import auth_manager
    rules, audit = permissions.list_rules(), permissions.audit()
    # The audit says who ran which command, path or URL: a member sees only
    # their own grants and entries, an admin the whole install.
    if not auth_manager.is_admin(user):
        rules = [rule for rule in rules if rule.get("granted_by") == user]
        audit = [entry for entry in audit if entry.get("by") == user]
    return {"rules": rules, "audit": audit[-50:]}


@router.post("/{request_id}/answer")
async def answer(request_id: str, body: Answer, request: Request, user: str = Depends(require_user)) -> dict:
    # A request id is server-made and lives only while something is waiting on
    # it, so a stale or invented id answers nothing.
    pending = permissions.pending_request(request_id)
    if pending and pending.surface == cli_access.SURFACE and not cli_access.is_app_window(request):
        # Only the app window approves a terminal. A paired terminal answering
        # this would let one token mint the next (core/cli_access.py).
        raise HTTPException(404, "request not found")
    if pending and pending.tool == "creative_tools" and pending.arguments.get("account_owner") != user:
        raise HTTPException(403, "Only this creative account's owner can approve the request.")
    if pending and pending.surface.startswith("chat:"):
        from services.chat_live import require_session
        require_session(pending.surface.removeprefix("chat:"), user)
    elif pending:
        from core.auth import auth_manager
        if not auth_manager.is_admin(user):
            raise HTTPException(404, "request not found")
    if not permissions.answer(request_id, body.choice, user):
        raise HTTPException(409, "That request is no longer waiting for an answer.")
    chat_live.permission_answered(request_id)
    return {"status": "answered"}


@router.delete("/{rule_id}")
async def revoke(rule_id: str, user: str = Depends(require_admin)) -> dict:
    if not permissions.revoke(rule_id):
        raise HTTPException(404, "No such rule")
    return {"status": "revoked"}


class Response(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answers: dict[str, str | list[str]] | None = None
    skip: bool = False


@router.post("/{request_id}/respond")
async def respond(request_id: str, body: Response, user: str = Depends(require_user)) -> dict:
    from core.auth import SINGLE_USER, auth_manager
    missing = "That question is no longer waiting for an answer."
    pending = permissions.pending_request(request_id)
    if not pending or pending.kind != "question" or not pending.surface.startswith("chat:"):
        raise HTTPException(404, missing)
    session = chat_live.chat_service.session_manager.get_session(pending.surface.removeprefix("chat:"))
    if not session:
        raise HTTPException(404, missing)
    owner = session.get("owner_user")
    if owner != user and not (owner is None and (user == SINGLE_USER or auth_manager.is_admin(user))):
        raise HTTPException(404, missing)
    if session.get("forge") and not auth_manager.is_admin(user):
        raise HTTPException(404, missing)
    error = permissions.respond(request_id, answers=body.answers, skip=body.skip, user=user)
    if error:
        raise HTTPException(409, error)
    chat_live.permission_answered(request_id)
    return {"status": "skipped" if body.skip else "answered"}
