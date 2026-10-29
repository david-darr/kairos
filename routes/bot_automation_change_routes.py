"""Bots redesign, Phase 3 unit U5: bot-made automation changes, reviewed and undone (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6 and 9.

    GET  /api/bot-automation-changes?bot_id=&thread_id=      the caller's receipts
    GET  /api/bot-automation-changes/{receipt_id}            one receipt, with its details
    POST /api/bot-automation-changes/{receipt_id}/undo       revision-checked inverse

A receipt is created only by a bot's tool call (core/bot_automation_tools.py),
never by these routes. Admin only; a receipt that belongs to someone else, or
does not exist, is a 404. Undo is idempotent and refuses safely (409) when the
target changed after the receipt.
"""
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from core.middleware import require_admin
from services import bot_automation_changes as changes

router = APIRouter(prefix="/api/bot-automation-changes", tags=["bot-automation-changes"])


def _refuse(error: changes.ChangeRefused) -> JSONResponse:
    return JSONResponse({"detail": str(error), "code": error.code}, status_code=error.status)


@router.get("")
async def list_changes(bot_id: Optional[str] = None, thread_id: Optional[str] = None,
                       user: str = Depends(require_admin)) -> dict:
    return {"changes": changes.store().list_receipts(user, bot_id=bot_id, thread_id=thread_id)}


@router.get("/{receipt_id}")
async def get_change(receipt_id: str, user: str = Depends(require_admin)):
    try:
        return changes.store().get(receipt_id, user)
    except changes.ChangeRefused as error:
        return _refuse(error)


@router.post("/{receipt_id}/undo")
async def undo_change(receipt_id: str, user: str = Depends(require_admin)):
    try:
        return changes.store().undo(receipt_id, user)
    except changes.ChangeRefused as error:
        return _refuse(error)
