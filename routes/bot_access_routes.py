"""A bot's access: what it may reach and the grants that set it (Bots Phase 2 unit U4).

GET/PUT /api/bots/{id}/access. Signed-in users only. The owner is the signed-in user, never a request field.
Saves are immediate and checked against the grants revision the client last read: a stale save is a
409 carrying the current state. Spec: phase-2-design.md, sections 5 and 7 (U4).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.middleware import require_user
from services import bot_grants, bot_record
from services.agent_service import agent_service

router = APIRouter(prefix="/api/bots", tags=["bots"])


class AccessBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int
    tool_scope: Optional[dict] = None
    connector_scopes: Optional[dict] = None
    integration_ids: Optional[list[str]] = None
    connector_tools: Optional[dict] = None
    clear_integration_ids: bool = False


def _scope(bot_id: str, user: str) -> bot_grants.Scope:
    from core.auth import auth_manager
    if agent_service.get(bot_id) is None:
        raise HTTPException(404, "That bot does not exist.")
    return bot_grants.Scope(bot_id, user, auth_manager.is_admin(user))


@router.get("/{bot_id}/access")
async def get_access(bot_id: str, user: str = Depends(require_user)) -> dict:
    return bot_grants.effective(_scope(bot_id, user))


@router.put("/{bot_id}/access")
async def put_access(bot_id: str, body: AccessBody, user: str = Depends(require_user)) -> dict:
    scope = _scope(bot_id, user)
    sent = body.model_dump(exclude_unset=True)
    changes = {k: v for k, v in sent.items() if k in ("tool_scope", "connector_scopes", "integration_ids", "connector_tools")}
    if body.clear_integration_ids:
        changes["integration_ids"] = None
    try:
        return bot_grants.save(scope, changes, body.expected_revision)
    except bot_grants.Stale as error:
        raise HTTPException(409, str(error))
    except bot_grants.Unavailable as error:
        raise HTTPException(422, str(error))
    except bot_record.BotConflict as error:
        raise HTTPException(409, str(error))
    except ValueError as error:
        raise HTTPException(400, str(error))
