"""Characters for Pack A videos (Video Styles unit 3): versioned specs, their reference sheets and the person's approval.

Every route needs the signed-in person and works in their own account's characters only (core/character_store.py).
Approving or rejecting a sheet is the person's step and exists only here; no model tool can do it. The sheet page
itself is also served to the desktop app's render worker on a short-lived signed token (no sign-in), like the
video player.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from core import accounts, character_sheet, character_store, design_render, three_vendor
from core.middleware import get_current_user, require_user

router = APIRouter(prefix="/api/characters", tags=["characters"])
SHEET_PAGE_PATH = re.compile(r"/api/characters/[a-f0-9]{12}/sheet")


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateBody(Body):
    family: str = Field(max_length=20)
    name: Optional[str] = Field(None, max_length=40)
    changes: dict[str, Any] = Field(default_factory=dict)


class VersionBody(Body):
    changes: dict[str, Any]
    note: str = Field("", max_length=300)


class ReasonBody(Body):
    reason: str = Field("", max_length=500)


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except character_store.ApprovalError as error:
        raise HTTPException(409, str(error)) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def _public(meta):
    out = {k: v for k, v in meta.items() if k != "notified"}
    out["approved_version"] = character_store.approved_version(meta)
    out["versions"] = [{**v, "sheet_url": f"/api/characters/{meta['id']}/versions/{v['version']}/sheet.png" if v["sheet"] else None}
                       for v in meta["versions"]]
    return out


@router.get("")
def list_characters(user: str = Depends(require_user)):
    return {"characters": [_public(m) for m in character_store.list_all()], "pending": character_store.pending(),
            "families": list(character_store.FAMILIES), "starters": character_store.STARTERS}


@router.post("")
def create_character(body: CreateBody, user: str = Depends(require_user)):
    changes = dict(body.changes)
    if body.name:
        changes["name"] = body.name
    data = _call(character_store.starter, body.family, **changes)
    return _public(_call(character_store.create, data, by=user))


@router.get("/{character_id}")
def get_character(character_id: str, user: str = Depends(require_user)):
    meta = _call(character_store.get, character_id)
    return {**_public(meta), "spec": _call(character_store.spec, character_id, meta["versions"][-1]["version"])}


@router.get("/{character_id}/versions/{version}")
def get_version(character_id: str, version: int, user: str = Depends(require_user)):
    meta = _call(character_store.get, character_id)
    return {"version": _call(character_store.version_of, meta, version), "spec": _call(character_store.spec, character_id, version)}


@router.post("/{character_id}/versions")
def new_version(character_id: str, body: VersionBody, user: str = Depends(require_user)):
    return _public(_call(character_store.new_version, character_id, body.changes, by=user, note=body.note))


@router.post("/{character_id}/versions/{version}/sheet")
async def make_sheet(character_id: str, version: int, user: str = Depends(require_user)):
    """Render the version's reference sheet and send it for approval."""
    try:
        return _public(await character_sheet.submit(character_id, version))
    except character_sheet.Unavailable as error:
        raise HTTPException(503, str(error)) from None
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except character_store.ApprovalError as error:
        raise HTTPException(409, str(error)) from None
    except (ValueError, RuntimeError) as error:
        raise HTTPException(422, str(error)) from None


@router.get("/{character_id}/versions/{version}/sheet.png")
def sheet_png(character_id: str, version: int, user: str = Depends(require_user)):
    path = _call(character_store.sheet_path, character_id, version)
    if not path.is_file():
        raise HTTPException(404, "This version has no sheet yet.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/{character_id}/versions/{version}/approve")
def approve(character_id: str, version: int, user: str = Depends(require_user)):
    """The person's OK on the sheet. From now on videos may cast this version."""
    return _public(_call(character_store.decide, character_id, version, True, user))


@router.post("/{character_id}/versions/{version}/reject")
def reject(character_id: str, version: int, body: ReasonBody = ReasonBody(), user: str = Depends(require_user)):
    return _public(_call(character_store.decide, character_id, version, False, user, body.reason))


@router.get("/{character_id}/sheet")
def sheet_page(character_id: str, request: Request, v: int = 1, rt: Optional[str] = None):
    """The sheet page for the render worker (signed token, no sign-in) or a signed-in person."""
    if rt is None:
        if get_current_user(request) is None:
            raise HTTPException(401, "authentication required")
        html = _call(character_sheet.page, character_id, v)
    else:
        account = design_render.token_account(character_id, character_sheet.SCOPE.format(version=v), rt)
        if account is None:
            raise HTTPException(404, "Character not found")
        with accounts.as_account(account):
            html = _call(character_sheet.page, character_id, v)
    origin = f"{request.url.scheme}://{request.url.netloc}"
    csp = (f"default-src 'none'; script-src {three_vendor.script_src(origin)}; style-src 'unsafe-inline'; img-src 'none'; "
           f"connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
    return HTMLResponse(html, headers={"Content-Security-Policy": csp, "Cache-Control": "no-store",
                                       "X-Kairos-Design-Render": "1", "X-Frame-Options": "SAMEORIGIN"})
