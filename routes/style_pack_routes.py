"""User-made style packs (Video Styles build spec, section 3 "User-made style packs"; core/style_pack_store.py).

Every route needs the signed-in person and works in their own account's packs only. Approving or rejecting a pack is
the person's step and exists only here; no model tool can do it. A pack is made from a written brief (a model turns it
into pack data, core/style_pack_brief.py), by duplicating one, from the starter pack, or by importing a pack file;
its sample renders in the background (core/style_pack_sample.py) and the version then waits for the person.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from core import blender_tools, character_sheet, style_pack_brief, style_pack_sample, style_pack_store, style_packs
from core.middleware import require_user

router = APIRouter(prefix="/api/style-packs", tags=["style-packs"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateBody(Body):
    source: str = Field(max_length=20)                       # brief, duplicate or starter
    brief: str = Field("", max_length=style_pack_store.BRIEF_LIMIT)
    endpoint_id: Optional[str] = Field(None, max_length=80)
    pack_id: Optional[str] = Field(None, max_length=12)      # duplicate: the pack to copy
    version: Optional[int] = None
    starter: Optional[str] = Field(None, max_length=40)
    name: str = Field("", max_length=60)


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
    except style_pack_store.ApprovalError as error:
        raise HTTPException(409, str(error)) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def _public(meta):
    out = {k: v for k, v in meta.items() if k not in ("notified", "step")}
    out["approved_version"] = style_pack_store.approved_version(meta)
    base = f"/api/style-packs/{meta['id']}/versions"
    versions = []
    for v in meta["versions"]:
        ready = bool(v.get("sample") and v["sample"].get("status") == "ready")
        versions.append({**v, "sample_url": f"{base}/{v['version']}/sample.mp4" if ready else None,
                         "sheet_url": f"{base}/{v['version']}/sample-sheet.png" if ready else None,
                         "export_url": f"/api/style-packs/{meta['id']}/export?v={v['version']}"})
    out["versions"] = versions
    try:
        out["spec"] = style_pack_store.spec(meta["id"], meta["versions"][-1]["version"])
    except LookupError:
        out["spec"] = None
    return out


@router.get("")
def list_packs(user: str = Depends(require_user)):
    return {"packs": [_public(m) for m in style_pack_store.list_all()],
            "built_in": [{"id": k, **v} for k, v in style_packs.BUILT_IN.items()],
            "available": [{"id": p["id"], "name": p["name"]} for p in [{"id": k, **v} for k, v in style_packs.all_packs().items()]
                          if p["available"]],
            "starters": style_pack_store.starters(),
            # Pack B's renderers: three.js always; Blender only when it is installed (core/blender_tools.py).
            "renderers": blender_tools.status(),
            "pending": [{k: v for k, v in p.items() if k != "spec"} for p in style_pack_store.pending()]}


@router.post("")
async def create_pack(body: CreateBody, user: str = Depends(require_user)):
    """A new pack as a draft: from a written brief, a duplicate, or the starter pack."""
    if body.source == "starter":
        return _public(_call(style_pack_store.install_starter, body.starter or style_pack_store.STARTER_ID, by=user))
    if body.source == "duplicate":
        return _public(_call(style_pack_store.duplicate, body.pack_id, body.version, name=body.name.strip(), by=user))
    if body.source != "brief":
        raise HTTPException(422, "source: choose brief, duplicate or starter.")
    try:
        data = await style_pack_brief.draft(body.brief, body.endpoint_id)
    except LookupError as error:
        raise HTTPException(409, str(error).strip("'")) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if body.name.strip():
        data["name"] = body.name.strip()
    data = _call(style_pack_store.default_cast, data, by=user)
    return _public(_call(style_pack_store.create, data, by=user, note="From a brief.",
                         origin={"kind": "brief", "from": user, "brief": body.brief}))


@router.post("/import")
async def import_pack(request: Request, user: str = Depends(require_user)):
    """A pack file (the JSON body, or a multipart file field) into this account as a draft. Data only; checked strictly."""
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if not hasattr(upload, "read"):
            raise HTTPException(422, "Choose a style pack file.")
        try:
            raw = await upload.read(style_pack_store.MAX_FILE_BYTES + 1)
            name = (upload.filename or "a pack file")[:80]
        finally:
            await form.close()
    else:
        raw = b""
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > style_pack_store.MAX_FILE_BYTES:
                break
        name = "a pack file"
    try:
        return _public(style_pack_store.import_bytes(raw, by=user, source=name))
    except style_pack_store.ImportRefused as error:
        raise HTTPException(422, str(error)) from None
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.get("/{pack_id}")
def get_pack(pack_id: str, user: str = Depends(require_user)):
    return _public(_call(style_pack_store.get, pack_id))


@router.get("/{pack_id}/versions/{version}")
def get_version(pack_id: str, version: int, user: str = Depends(require_user)):
    meta = _call(style_pack_store.get, pack_id)
    return {"version": _call(style_pack_store.version_of, meta, version), "spec": _call(style_pack_store.spec, pack_id, version)}


@router.post("/{pack_id}/versions")
def new_version(pack_id: str, body: VersionBody, user: str = Depends(require_user)):
    """Any change (the brief included) is a new draft version."""
    return _public(_call(style_pack_store.new_version, pack_id, body.changes, by=user, note=body.note))


@router.post("/{pack_id}/versions/{version}/sample")
async def make_sample(pack_id: str, version: int, user: str = Depends(require_user)):
    """Send any unapproved character sheet first; else start rendering the sample (it takes minutes; poll the pack)."""
    meta = _call(style_pack_store.get, pack_id)
    v = _call(style_pack_store.version_of, meta, version)
    if v["status"] == "approved":
        raise HTTPException(409, f"Version {version} is already approved.")
    data = _call(style_pack_store.spec, pack_id, version)
    if data["base"] == "voxel-3d":
        raise HTTPException(422, f"{meta['name']} is drawn by the voxel-3d base, which is not built yet.")
    try:
        if style_pack_sample.waiting_characters(data):
            return _public(await style_pack_sample.make(pack_id, version, owner=user, by=user))
        from core import design_render_bridge, ffmpeg_tools
        if not ffmpeg_tools.find():
            raise HTTPException(503, ffmpeg_tools.MISSING)
        if not design_render_bridge.available():
            raise HTTPException(503, "Rendering a sample needs the Kairos desktop app. Open it and try again.")
        style_pack_store.set_sample_status(pack_id, version, "rendering")
        style_pack_sample.start(pack_id, version, owner=user, by=user)
    except character_sheet.Unavailable as error:
        raise HTTPException(503, str(error)) from None
    except style_pack_store.ApprovalError as error:
        raise HTTPException(409, str(error)) from None
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except (ValueError, RuntimeError) as error:
        raise HTTPException(422, str(error)) from None
    return _public(style_pack_store.get(pack_id))


def _file(pack_id, version, kind, media):
    path = _call(style_pack_store.sample_path, pack_id, version, kind)
    if not path.is_file():
        raise HTTPException(404, "This version has no sample yet.")
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})


@router.get("/{pack_id}/versions/{version}/sample.mp4")
def sample_video(pack_id: str, version: int, user: str = Depends(require_user)):
    return _file(pack_id, version, "mp4", "video/mp4")


@router.get("/{pack_id}/versions/{version}/sample-sheet.png")
def sample_sheet(pack_id: str, version: int, user: str = Depends(require_user)):
    return _file(pack_id, version, "sheet", "image/png")


@router.post("/{pack_id}/versions/{version}/approve")
def approve(pack_id: str, version: int, user: str = Depends(require_user)):
    """The person's OK on the pack's sample. From now on channels and videos may use this version."""
    return _public(_call(style_pack_store.decide, pack_id, version, True, user))


@router.post("/{pack_id}/versions/{version}/reject")
def reject(pack_id: str, version: int, body: ReasonBody = ReasonBody(), user: str = Depends(require_user)):
    return _public(_call(style_pack_store.decide, pack_id, version, False, user, body.reason))


@router.get("/{pack_id}/export")
def export_pack(pack_id: str, v: Optional[int] = None, user: str = Depends(require_user)):
    """The pack as one file: data only, characters as specs, nothing secret."""
    meta = _call(style_pack_store.get, pack_id)
    raw = _call(style_pack_store.export_bytes, pack_id, v)
    slug = "".join(c if c.isalnum() else "-" for c in meta["name"].lower()).strip("-")[:40] or "style-pack"
    return Response(raw, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{slug}.kairos-style.json"', "Cache-Control": "no-store"})
