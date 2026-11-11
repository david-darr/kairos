"""Authenticated video CRUD and a narrowly signed, offline-only player page."""
from __future__ import annotations
import asyncio
import json
import re
from pathlib import Path
from typing import Any, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field
from core import (accounts, design_render, design_render_bridge, design_systems, ffmpeg_tools, video_agent, video_export, video_longform,
                  video_media, video_plan, video_render, three_vendor, video_store)
from core.auth import auth_manager
from core.middleware import get_current_user, require_user
from core.constants import STATIC_DIR

router = APIRouter(tags=["videos"])
PLAYER_PATH = re.compile(r"/api/videos/[a-f0-9]{12}/player")


class VideoBody(BaseModel):
    """Bound client input; server-owned metadata is accepted only for round trips."""
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    look: str = Field(min_length=1, max_length=60)
    beats: list[dict[str, Any]] = Field(min_length=1, max_length=video_store.CHAPTERED_MAX_BEATS)
    bpm: float = 120
    fps: int = 30
    aspects: list[str] = Field(default=["16:9"], min_length=1, max_length=3)
    music: dict[str, Any] = Field(default={"mood": "energetic", "volume": .7})
    narration: Optional[dict[str, Any]] = None
    cast: Optional[list[dict[str, Any]]] = None      # Pack A: characters pinned to versions
    palette: Optional[str] = Field(None, max_length=24)
    style_pack: Optional[dict[str, Any]] = None       # a user-made style pack, {id, version}
    chapters: Optional[list[dict[str, Any]]] = Field(None, max_length=video_store.MAX_CHAPTERS)   # a long video's chapters
    renderer: Optional[str] = Field(None, max_length=10)   # Pack B's 3D stage beats: threejs (built in) or blender (when installed)
    tracks: Optional[list[dict[str, Any]]] = Field(None, max_length=8)   # overlay and audio tracks over the beats (core/video_tracks.py)
    id: Optional[str] = None
    owner: Optional[str] = None
    chat_ids: list[str] = []
    visible_to: list[str] = []
    version: Optional[int] = None
    created: Optional[float] = None
    updated: Optional[float] = None

    def project(self):
        return {k: v for k, v in self.model_dump().items()
                if k in video_store.FIELDS and (k not in ("id", "narration", "cast", "palette", "style_pack", "chapters", "renderer", "tracks") or v is not None)}


class RenderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aspect: str = "16:9"
    format: str = Field("mp4", pattern=r"^(mp4|webm|mov|gif)$")   # step 6: other formats are encoded from the MP4
    start: Optional[float] = Field(None, ge=0, le=1200)             # a GIF's stretch (the editor's work area)
    end: Optional[float] = Field(None, ge=0, le=1200)


class CopyAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design_id: str = Field(pattern=r"^[a-f0-9]{12}$")
    asset: str = Field(max_length=100)


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except (ValueError, PermissionError) as error:
        raise HTTPException(422, str(error)) from None
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from None


def _video(video_id, user):
    return _call(video_store.require_user_access, video_id, user, auth_manager.is_admin(user))


def _look(look, user):
    system = design_systems.get(look)
    if not system or not design_systems.visible(system, user, auth_manager.is_admin(user)):
        raise HTTPException(422, "look: choose a visible look with creative_direction.")
    return system


@router.get("/api/videos/ffmpeg")
async def ffmpeg_status(user: str = Depends(require_user)):
    found = ffmpeg_tools.find()
    return {"found": bool(found), "version": ffmpeg_tools.version() if found else None,
            "message": "FFmpeg is ready." if found else ffmpeg_tools.MISSING}


@router.get("/api/videos")
async def list_videos(user: str = Depends(require_user)):
    return video_store.list_for_user(user, auth_manager.is_admin(user))


@router.post("/api/videos")
async def create_video(body: VideoBody, user: str = Depends(require_user)):
    p = body.project()
    p.pop("id", None)
    _look(p["look"], user)
    return _call(video_store.create, owner=user, **p)


@router.get("/api/videos/{video_id}")
async def get_video(video_id: str, user: str = Depends(require_user)):
    return _video(video_id, user)


@router.put("/api/videos/{video_id}")
async def put_video(video_id: str, body: VideoBody, user: str = Depends(require_user)):
    current = _video(video_id, user)
    _look(body.look, user)
    # The Studio and a model's video_edit can edit the same video; a save made from an older version is refused
    # instead of silently replacing the newer one.
    if body.version is not None and body.version != current.get("version"):
        raise HTTPException(409, f"This video changed since you opened it (it is now version {current.get('version')}). "
                                 "Your last change wasn't saved; the latest version is loaded, make the change again.")
    return _call(video_store.save, video_id, {"id": video_id, **body.project()})


@router.delete("/api/videos/{video_id}")
async def delete_video(video_id: str, user: str = Depends(require_user)):
    _video(video_id, user)
    for job in video_render.jobs_for(video_id):
        if job["status"] not in ("ready",) and not job["status"].startswith("failed:"):
            video_render.cancel(job["id"])
    _call(video_store.delete, video_id)
    return {"ok": True}


@router.get("/api/video-renderers")
async def renderers(user: str = Depends(require_user)):
    """Pack B's 3D renderers for Studio: three.js always; Blender only when this computer has it (core/blender_tools.py)."""
    from core import blender_tools
    return blender_tools.status()


def _blender_ready():
    from core import blender_tools
    return blender_tools.find() is not None


def player_page(project):
    """Inject data, never executable project text, into lane D's fixed template."""
    path = Path(STATIC_DIR) / "motion" / "player.html"
    if not path.is_file():
        raise HTTPException(503, "The motion player is not available in this build yet.")
    page = path.read_text(encoding="utf-8")
    if "<!--KD-PROJECT-->" not in page or "<!--KD-TOKENS-->" not in page:
        raise HTTPException(503, "The motion player needs its project and token markers.")
    system = design_systems.get(project["look"])
    if not system:
        raise HTTPException(422, "look: this video's look is no longer available.")
    data = {k: v for k, v in project.items() if k in video_store.FIELDS}
    if project.get("cast"):
        # Each cast member's spec at its pinned version: the rig draws only from these numbers.
        from core import character_store
        try:
            data["characters"] = {cid: {"version": c["version"], "spec": c["spec"]}
                                  for cid, c in character_store.resolve(project["cast"]).items()}
        except LookupError as error:
            raise HTTPException(422, "cast: " + str(error).strip("'")) from None
    if project.get("renderer") == "blender" and not _blender_ready():
        data["renderer"] = "threejs"     # the page draws what will render: without Blender, three.js
    if any(c.get("kind") == "video" for t in project.get("tracks") or [] for c in t["clips"]):
        data["media"] = video_media.player_media(project)     # frame counts of the video files the clips use
    if project.get("style_pack"):
        # The pack's look as numbers and names (palette colours, lighting, caption case); nothing else of it reaches the page.
        from core import style_pack_store
        try:
            data["pack"] = style_pack_store.render_look(style_pack_store.spec(project["style_pack"]["id"], project["style_pack"]["version"]))
        except LookupError as error:
            raise HTTPException(422, "style_pack: " + str(error).strip("'")) from None
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    css = design_systems.tokens_css(system["tokens"]) + design_systems.font_faces(system["id"], "/api/design-fonts")
    if any(b.get("kind") == "story" for b in project["beats"]):
        # The Story Short's word captions (Pack C classic): Archivo Black (SIL Open Font License, bundled in
        # static/fonts/looks/archivoblack), served by the design-font route through the Brutalist look that ships it.
        css += ('\n@font-face { font-family: "Kairos Story Caption"; src: url("/api/design-fonts/brutalist/archivoblack-0.ttf"); '
                'font-weight: 400; font-style: normal; font-display: block; }')
    page = page.replace("<!--KD-PROJECT-->", '<script type="application/json" id="kd-project">' + data_json + '</script>')
    page = page.replace("<!--KD-TOKENS-->", '<style>' + css.replace("</", "<\\/") + '</style>')
    # Image paths stay assets/<hash> as the shared schema requires. Module URLs
    # are absolute because this page is served from the project's own route.
    page = re.sub(r'(src=["\'])(?:\./)?((?:engine|kit|layout)\.js)(["\'])', r'\1/static/motion/\2\3', page)
    return page


@router.get("/api/videos/{video_id}/player")
async def player(video_id: str, request: Request, aspect: str = "16:9", rt: Optional[str] = None, v: Optional[int] = None):
    # Without the worker's signed token, a person must be signed in before the video is even looked up, so an
    # anonymous caller learns nothing about which ids exist.
    if rt is None:
        user = get_current_user(request)
        if user is None:
            raise HTTPException(401, "authentication required")
        _video(video_id, user)
        return _player_response(video_id, request, aspect, v)
    # The worker has no sign-in: the token names the account whose folder the video is read from. The version
    # is part of what the token signs, so an unversioned request is checked against the current one.
    account = None
    for version in ([v] if v is not None else _versions(video_id, rt)):
        account = design_render.token_account(video_id, f"video:{aspect}:{version}", rt)
        if account:
            break
    if account is None:
        raise HTTPException(404, "Video not found")
    with accounts.as_account(account):
        return _player_response(video_id, request, aspect, v)


def _versions(video_id, rt):
    """The versions a token without an explicit one could have been made for: the account in the token's
    own claim decides whose store to ask for the current version."""
    account = design_render.asset_account(video_id, rt)
    if account is None:
        return []
    with accounts.as_account(account):
        try:
            return [video_store.get(video_id)["version"]]
        except LookupError:
            return []


def _player_response(video_id, request, aspect, v):
    current = _call(video_store.get, video_id)
    version = v if v is not None else current["version"]
    project = current
    if version != current["version"]:
        project = next((p for p in video_store.history(video_id) if p["version"] == version), None)
        if project is None:
            raise HTTPException(404, "Video version not found")
    if aspect not in project["aspects"]:
        raise HTTPException(422, "aspect: choose an aspect listed in the project.")
    origin = f"{request.url.scheme}://{request.url.netloc}"
    # Pack B's 3D stage loads the vendored three.js through the page's import map (core/three_vendor.py).
    csp = (f"default-src 'none'; script-src {three_vendor.script_src(origin)}; style-src 'unsafe-inline'; "
           f"img-src {origin}/api/videos/{video_id}/assets/; font-src {origin}/api/design-fonts/; "
           f"connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
    return HTMLResponse(player_page(project), headers={"Content-Security-Policy": csp, "Cache-Control": "no-store",
                                                       "X-Kairos-Design-Render": "1", "X-Frame-Options": "SAMEORIGIN"})


@router.get("/api/videos/{video_id}/assets/{name}")
async def get_asset(video_id: str, name: str, rt: Optional[str] = None):
    # Same immutable content-addressed capability as design assets: offscreen windows have no account
    # cookies, so the player page's token (the engine forwards it) names the account whose folder holds it.
    account = design_render.asset_account(video_id, rt) if rt else design_render.request_account()
    if account is None:
        raise HTTPException(404, "Video asset not found")
    with accounts.as_account(account):
        path = _call(video_store.asset_path, video_id, name)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                       "Access-Control-Allow-Origin": "*", "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.get("/api/videos/{video_id}/assets/media/{sha}/{frame}")
async def get_media_frame(video_id: str, sha: str, frame: str, rt: Optional[str] = None):
    """One decoded frame of a video file the person uploaded (core/video_media.py), by number; same capability as assets."""
    account = design_render.asset_account(video_id, rt) if rt else design_render.request_account()
    match = re.fullmatch(r"(\d{1,6})\.jpg", frame)
    if account is None or not match:
        raise HTTPException(404, "Video frame not found")
    with accounts.as_account(account):
        path = _call(video_media.frame_path, video_id, sha, match[1])
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                       "Access-Control-Allow-Origin": "*", "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.get("/api/videos/{video_id}/media")
async def media(video_id: str, user: str = Depends(require_user)):
    """The video files uploaded to this video: length, frames, size, title and the sound made from each."""
    _video(video_id, user)
    return {"media": video_media.info(video_id)}


@router.post("/api/videos/{video_id}/assets")
async def add_asset(video_id: str, request: Request, user: str = Depends(require_user)):
    _video(video_id, user)
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            body = CopyAsset.model_validate(await request.json())
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        asset = _call(video_store.add_asset, video_id, design_id=body.design_id, asset=body.asset,
                      user=user, is_admin=auth_manager.is_admin(user))
    else:
        form = await request.form()
        upload = form.get("file")
        if not hasattr(upload, "read"):
            raise HTTPException(422, "asset: upload an image or a sound in the file field.")
        try:
            ext = Path(upload.filename or "").suffix
            if ext.lower().lstrip(".") in video_media.TYPES:
                # A video for a video clip (step 7): the person's own file, decoded by FFmpeg into frames and its sound.
                raw = await upload.read(video_media.UPLOAD_LIMIT + 1)
                made = await asyncio.to_thread(_call, video_media.add_video, video_id, raw, ext, Path(upload.filename or "").stem)
                return {"media": made, "audio": video_store.audio_info(video_id).get(made.get("audio")) if made.get("audio") else None}
            if ext.lower().lstrip(".") in video_store.AUDIO_TYPES:
                # A sound for an audio clip (Content Studio Editor step 3): the person's own file, decoded by FFmpeg.
                raw = await upload.read(video_store.AUDIO_UPLOAD_LIMIT + 1)
                asset = await asyncio.to_thread(_call, video_store.add_audio, video_id, raw, ext, Path(upload.filename or "").stem)
                return {"asset": asset, "audio": video_store.audio_info(video_id).get(asset)}
            raw = await upload.read(25 * 1024 * 1024 + 1)
            asset = _call(video_store.add_asset, video_id, raw, ext)
        finally:
            await form.close()
    return {"asset": asset}


@router.get("/api/videos/{video_id}/audio")
async def audio(video_id: str, user: str = Depends(require_user)):
    """The sounds uploaded to this video, with their lengths and peak levels for the timeline's audio lanes."""
    _video(video_id, user)
    return {"sounds": video_store.audio_info(video_id)}


# -- Ask Kairos in the editor (Content Studio Editor step 4): comments on the preview, runs, dry runs and undo ---------

class CommentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: float
    x: float
    y: float
    text: str = Field(min_length=1, max_length=video_agent.COMMENT_LIMIT)
    under: str = Field("", max_length=200)


class CommentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Optional[str] = Field(None, max_length=video_agent.COMMENT_LIMIT)
    status: Optional[str] = Field(None, max_length=10)


class AskBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request: str = Field("", max_length=video_agent.REQUEST_LIMIT)
    selection: Optional[dict[str, Any]] = None
    comments: list[str] = Field(default=[], max_length=40)
    endpoint_id: Optional[str] = Field(None, max_length=80)


@router.get("/api/videos/{video_id}/review")
async def review(video_id: str, user: str = Depends(require_user)):
    _video(video_id, user)
    return _call(video_agent.review, video_id)


@router.post("/api/videos/{video_id}/comments")
async def add_comment(video_id: str, body: CommentBody, user: str = Depends(require_user)):
    _video(video_id, user)
    return _call(video_agent.add_comment, video_id, t=body.t, x=body.x, y=body.y, text=body.text, under=body.under)


@router.patch("/api/videos/{video_id}/comments/{comment_id}")
async def update_comment(video_id: str, comment_id: str, body: CommentPatch, user: str = Depends(require_user)):
    _video(video_id, user)
    return _call(video_agent.update_comment, video_id, comment_id, text=body.text, status=body.status)


@router.delete("/api/videos/{video_id}/comments/{comment_id}")
async def delete_comment(video_id: str, comment_id: str, user: str = Depends(require_user)):
    _video(video_id, user)
    _call(video_agent.delete_comment, video_id, comment_id)
    return {"ok": True}


@router.post("/api/videos/{video_id}/agent/ask")
async def ask_kairos(video_id: str, body: AskBody, user: str = Depends(require_user)):
    _video(video_id, user)
    try:
        return await video_agent.ask(video_id, body.request, body.selection, body.comments, body.endpoint_id)
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.post("/api/videos/{video_id}/agent/runs/{run_id}/{action}")
async def kairos_run(video_id: str, run_id: str, action: str, user: str = Depends(require_user)):
    _video(video_id, user)
    actions = {"apply": video_agent.apply, "discard": video_agent.discard, "undo": video_agent.undo}
    if action not in actions:
        raise HTTPException(404, "Choose apply, discard or undo.")
    return _call(actions[action], video_id, run_id)


@router.post("/api/videos/{video_id}/narrate")
async def narrate(video_id: str, user: str = Depends(require_user)):
    """Speak the lines not spoken yet and, with a word caption style, find each line's word times (core/video_align.py)."""
    from core import video_narration
    _video(video_id, user)
    try:
        return await asyncio.to_thread(video_narration.prepare, video_id)
    except video_narration.NarrationUnavailable as error:
        raise HTTPException(503, str(error)) from None
    except LookupError as error:
        raise HTTPException(404, str(error).strip("'")) from None


@router.post("/api/videos/{video_id}/render")
async def render_video(video_id: str, body: RenderBody, user: str = Depends(require_user)):
    _video(video_id, user)
    if body.format != "mp4":
        return _call(video_export.start, video_id, body.aspect, body.format, body.start, body.end)
    return _call(video_render.start, video_id, body.aspect)


def _job(job_id, user):
    state = _call(video_render.status, job_id)
    _video(state["video_id"], user)
    return {k: v for k, v in state.items() if k != "path"}


@router.get("/api/video-jobs/{job_id}")
async def get_job(job_id: str, user: str = Depends(require_user)):
    return _job(job_id, user)


@router.post("/api/video-jobs/{job_id}/cancel")
async def cancel_job(job_id: str, user: str = Depends(require_user)):
    _job(job_id, user)
    _call(video_render.cancel, job_id)
    return _job(job_id, user)


@router.get("/api/videos/{video_id}/renders/{file}")
async def download(video_id: str, file: str, user: str = Depends(require_user)):
    _video(video_id, user)
    if not re.fullmatch(r"(?:(?:16-9|9-16|1-1)-v[1-9][0-9]*\.(?:mp4|webm|mov|gif|chapters\.txt)|(?:sheet|thumb)-(?:16-9|9-16|1-1)\.png|soundtrack\.wav)", file):
        raise HTTPException(404, "Render not found")
    path = video_store._folder(video_id) / "renders" / file
    if not path.is_file():
        raise HTTPException(404, "Render not found")
    return FileResponse(path, filename=file)


@router.get("/api/videos/{video_id}/history")
async def history(video_id: str, user: str = Depends(require_user)):
    _video(video_id, user)
    return video_store.history(video_id)


@router.post("/api/videos/{video_id}/restore/{version}")
async def restore(video_id: str, version: int, user: str = Depends(require_user)):
    _video(video_id, user)
    return _call(video_store.restore, video_id, version)


# -- long videos (Video Styles unit 4): the person's plan approval, stored renders, parts on disk ------------------------

class PlanDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field("", max_length=500)


@router.get("/api/videos/{video_id}/plan")
async def get_plan(video_id: str, user: str = Depends(require_user)):
    project = _video(video_id, user)
    return {"chaptered": video_store.chaptered(project), **video_plan.state(project),
            "current": video_plan.plan_text(project) if video_store.chaptered(project) else ""}


@router.post("/api/videos/{video_id}/plan/approve")
async def approve_plan(video_id: str, user: str = Depends(require_user)):
    """The person approves the long video's shot plan as it is now. No model tool reaches this."""
    _video(video_id, user)
    return _plan_evidence(_call(video_plan.decide, video_id, True, user))


@router.post("/api/videos/{video_id}/plan/reject")
async def reject_plan(video_id: str, body: PlanDecision = PlanDecision(), user: str = Depends(require_user)):
    _video(video_id, user)
    return _plan_evidence(_call(video_plan.decide, video_id, False, user, body.reason))


def _plan_evidence(data):
    """A team post's plan decision is kept with the post's appeal evidence."""
    if data.get("post_id"):
        try:
            from services.content_studio import studio
            studio.add_evidence(data["post_id"], "plan_approval", {k: data.get(k) for k in (
                "status", "decided_by", "decided_at", "reason", "hash", "seconds", "chapters", "text")})
        except Exception:
            pass
    return data


@router.get("/api/videos/{video_id}/long-renders")
async def long_renders(video_id: str, user: str = Depends(require_user)):
    """Each aspect's long render as stored (a stopped one shows Resume after a restart) and the disk the renders take."""
    _video(video_id, user)
    return {"renders": video_longform.describe(video_id), "disk": video_longform.disk(video_id)}


@router.post("/api/videos/{video_id}/parts/clean")
async def clean_parts(video_id: str, user: str = Depends(require_user)):
    """Remove the saved chapter parts; a stopped long render then starts again from its first chapter."""
    _video(video_id, user)
    freed = _call(video_longform.clean, video_id)
    return {"freed": freed, "disk": video_longform.disk(video_id)}
