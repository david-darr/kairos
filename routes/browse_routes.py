"""Browse's own requests (vault: "Kairos Browser - Phase 1 (Build Spec)").

Cookie-only (core/cli_access.py COOKIE_ONLY): Browse is the desktop app's own
window, never a paired terminal.

- POST /shared marks a chat as carrying a web page the person shared from
  Browse ("Share this page" in Ask Kairos). The page arrives as an ordinary
  chat attachment; this mark makes the taint rules apply to every turn of
  that chat (services/chat_service.py _taint_turn), exactly as files dropped
  on the notch do. A page is outside content: it may carry instructions
  aimed at the model, and must never be read as the person's own words.
"""
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from core.middleware import require_user
from services import chat_live

router = APIRouter(prefix="/api/browse", tags=["browse"])

SHARED_REASON = "a web page shared from Browse"


class SharedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: Annotated[str, Field(min_length=1, max_length=100)]


@router.post("/shared")
async def mark_shared(body: SharedRequest, user: str = Depends(require_user)) -> dict:
    chat_live.require_session(body.session_id, user)
    from core.session_manager import session_manager
    session_manager.set_untrusted_context(body.session_id, SHARED_REASON)
    return {"status": "marked"}
