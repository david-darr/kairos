"""The front-desk Make collection. Registered by app.py at integration."""
from typing import Literal

from fastapi import APIRouter, Depends, Query

from core.middleware import require_user
from services import front_desk_make

router = APIRouter(prefix="/api/front-desk", tags=["front-desk"])


@router.get("/make")
def make(kind: Literal["all", "design", "slides", "website", "files"] | None = Query(default=None),
         user: str = Depends(require_user)) -> dict:
    return front_desk_make.list_make(user=user, kind=kind)
