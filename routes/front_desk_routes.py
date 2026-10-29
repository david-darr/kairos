"""Admin-only front-desk lifecycle and roster. Startup seeding is not a GET side effect."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from core.middleware import require_admin
from services import front_desk, front_desk_routing

router = APIRouter(prefix="/api/front-desk", tags=["front-desk"])


class EnsureBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


@router.post("/ensure")
def ensure(body: EnsureBody = EnsureBody(), user: str = Depends(require_admin)):
    try:
        agent = front_desk.ensure(restore=True)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"agent": agent, "bot_id": agent["id"], "main_thread_id": front_desk.main_thread_id()}


@router.get("/state")
def state(user: str = Depends(require_admin)):
    return front_desk.state()


@router.get("/roster")
def roster(user: str = Depends(require_admin)):
    return front_desk_routing.roster()
