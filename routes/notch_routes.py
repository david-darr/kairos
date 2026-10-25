"""The desktop notch's own requests (Kairos Notch build spec, phase 3).

Cookie-only (core/cli_access.py COOKIE_ONLY): the notch is the app's own
window, never a paired terminal.

- POST /folder asks for a path-root grant for a dropped folder, through the
  permissions broker, and streams the request and its outcome. Admin only:
  a folder is a path on this computer, and only an admin chat may reach the
  computer's files (core/brain.py fence_roots).
- POST /dropped marks a new chat as carrying dropped files, so the taint
  rules apply to every turn that reads them.
"""
import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from core import notch_folders, permissions
from core.middleware import require_admin, require_user
from services import chat_live

router = APIRouter(prefix="/api/notch", tags=["notch"])


class FolderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: Annotated[str, Field(min_length=1, max_length=100)]
    path: Annotated[str, Field(min_length=1, max_length=notch_folders.MAX_PATH)]


class DroppedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: Annotated[str, Field(min_length=1, max_length=100)]


def _event(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def _decide(session_id: str, path: str):
    """A saved rule answers without asking; otherwise the person is asked,
    and only by the notch: Auto never answers a folder (core/permissions.py)."""
    saved = notch_folders.saved_decision(session_id, path)
    if saved is not None:
        return saved, None
    surface = notch_folders.surface(session_id)
    queue = permissions.open_channel(surface)
    task = asyncio.create_task(permissions.decide(
        surface=surface, tool=notch_folders.TOOL, arguments={"path": path}, target=path,
        title=f"Allow Kairos to read {path}?",
        description="A folder dropped on the notch. The chat gets its path and a list of file names, never the files themselves.",
        choices=notch_folders.choices(path), is_admin=True, force_prompt=True))
    return task, queue


@router.post("/folder")
async def drop_folder(body: FolderRequest, user: str = Depends(require_admin)) -> StreamingResponse:
    chat_live.require_session(body.session_id, user)
    path = notch_folders.normalize(body.path)
    if path is None:
        raise HTTPException(422, "That is not a folder on this computer.")
    if notch_folders.surface(body.session_id) in permissions._channels:
        raise HTTPException(409, "This chat is busy. Wait for its reply, then drop the folder again.")

    async def stream():
        decision, queue = await _decide(body.session_id, path)
        if queue is not None:
            task = decision
            try:
                while not task.done():
                    asked = asyncio.ensure_future(queue.get())
                    done, _ = await asyncio.wait({task, asked}, return_when=asyncio.FIRST_COMPLETED)
                    if asked in done:
                        packet = asked.result()
                        if "permission_closed" not in packet:
                            yield _event({"permission": packet})
                    else:
                        asked.cancel()
                decision = task.result()
            finally:
                # A closed notch or a dropped stream denies: silence is never a yes.
                permissions.close_channel(notch_folders.surface(body.session_id))
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        if decision.behavior != "allow":
            yield _event({"status": "rejected"})
            return
        from core.session_manager import session_manager
        session_manager.set_untrusted_context(body.session_id, "a folder dropped on the desktop notch")
        yield _event({"status": "allowed", "folder": notch_folders.remember(body.session_id, path, user)})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@router.post("/dropped")
async def mark_dropped(body: DroppedRequest, user: str = Depends(require_user)) -> dict:
    chat_live.require_session(body.session_id, user)
    from core.session_manager import session_manager
    session_manager.set_untrusted_context(body.session_id, "files dropped on the desktop notch")
    return {"status": "marked"}
