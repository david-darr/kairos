"""Bots redesign, Phase 3 unit U5: the durable approval and question cards' routes (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 5.3 and 6.

    GET  /api/bot-cards?thread_id=&bot_id=&status=   the caller's own cards
    POST /api/bot-cards/{id}/respond                 allow, deny, answer or skip
    POST /api/bot-cards/{id}/resume                  finish or decline a typed card

Admin only, and every card is checked against its owner: someone else's card,
or one that does not exist, is a 404. The services/bot_cards.py module owns the
rules; these routes only check access and validate the body.
"""
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.middleware import require_admin
from services import bot_cards

router = APIRouter(prefix="/api/bot-cards", tags=["bot-cards"])

Answer = Annotated[str, Field(min_length=1, max_length=bot_cards.MAX_CUSTOM_ANSWER)]


class RespondBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action: Literal["allow", "deny", "answer", "skip"]
    choice_id: Optional[Annotated[str, Field(min_length=1, max_length=40)]] = None
    remember: Optional[Literal["once", "session", "always"]] = None
    answers: Optional[dict[Annotated[str, Field(min_length=1, max_length=2000)],
                           Answer | Annotated[list[Answer], Field(max_length=bot_cards.MAX_OPTIONS + 1)]]] = None
    reviewed_revision: Optional[Annotated[int, Field(ge=1)]] = None

    @field_validator("answers")
    @classmethod
    def few_answers(cls, value):
        if value is not None and len(value) > bot_cards.MAX_QUESTIONS:
            raise ValueError("too many answers")
        return value


class ResumeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["done", "skipped"]


def _own_thread(thread_id: str, user: str) -> None:
    from core.auth import SINGLE_USER
    from core.session_manager import session_manager
    session = session_manager.get_session(thread_id)
    if not session or (session.get("owner_user") or SINGLE_USER) != user:
        raise HTTPException(404, "conversation not found")


def _refuse(error: bot_cards.CardError) -> JSONResponse:
    body = {"detail": str(error)}
    if error.card is not None:
        body["card"] = error.card
    return JSONResponse(body, status_code=error.status)


@router.get("")
async def list_cards(thread_id: Optional[str] = None, bot_id: Optional[str] = None,
                     status: Optional[Literal["pending", "allowed", "denied", "answered", "skipped", "expired",
                                              "unavailable", "cancelled"]] = None,
                     user: str = Depends(require_admin)) -> dict:
    if thread_id:
        _own_thread(thread_id, user)
    cards = bot_cards.store().list_cards(user, thread_id=thread_id, bot_id=bot_id, status=status)
    return {"cards": cards, "pending": sum(1 for card in cards if card["waiting"])}


@router.post("/{card_id}/respond")
async def respond(card_id: str, body: RespondBody, user: str = Depends(require_admin)):
    try:
        result = bot_cards.store().respond(card_id, user, action=body.action, choice_id=body.choice_id,
                                           remember=body.remember, answers=body.answers,
                                           reviewed_revision=body.reviewed_revision)
    except bot_cards.CardError as error:
        return _refuse(error)
    request_id = result.pop("request_id", None)
    if request_id:
        try:
            from services import chat_live
            chat_live.permission_answered(request_id)
        except Exception:  # the card is settled either way; the live feed catches up
            pass
    return result


@router.post("/{card_id}/resume")
async def resume(card_id: str, body: ResumeBody, user: str = Depends(require_admin)):
    try:
        return bot_cards.store().resume_card(card_id, user, body.outcome)
    except bot_cards.CardError as error:
        return _refuse(error)
