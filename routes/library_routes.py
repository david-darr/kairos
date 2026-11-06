"""The shared library on this Kairos (Multi-Account phase 5, D6; services/shared_library.py).

Every route needs a signed-in account and acts as that account: it lists what is shared, shares one of
its own items, adds a private copy of someone else's, applies a re-share it was offered, or unshares its own.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.middleware import require_user
from services import shared_library

router = APIRouter(prefix="/api/library", tags=["library"])


class ShareRequest(BaseModel):
    kind: str
    ref: str
    description: str = ""


class AddRequest(BaseModel):
    # The person's explicit "add anyway" after a caution report; never overrides a dangerous verdict.
    confirmed: bool = False


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except shared_library.LibraryError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("")
def list_library(user: str = Depends(require_user)):
    return {"items": _run(shared_library.list_items)}


@router.post("/share")
def share(body: ShareRequest, user: str = Depends(require_user)):
    return _run(shared_library.share, body.kind, body.ref, body.description)


@router.get("/{item_id}")
def item_details(item_id: str, user: str = Depends(require_user)):
    return _run(shared_library.details, item_id)


@router.delete("/{item_id}")
def unshare(item_id: str, user: str = Depends(require_user)):
    _run(shared_library.unshare, item_id)
    return {"ok": True}


@router.post("/{item_id}/add")
def add(item_id: str, body: AddRequest = AddRequest(), user: str = Depends(require_user)):
    return _run(shared_library.add, item_id, body.confirmed)


@router.post("/{item_id}/update")
def update(item_id: str, body: AddRequest = AddRequest(), user: str = Depends(require_user)):
    return _run(shared_library.update, item_id, body.confirmed)
