"""Review and conflict-checked rollback of the account's own model file checkpoints. A rollback writes to files on
this computer, only the paths the checkpoint recorded, and needs the account's machine access."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import accounts, file_checkpoints
from core.middleware import require_user

router = APIRouter(prefix="/api/file-checkpoints", tags=["file-checkpoints"])


class RestoreRequest(BaseModel):
    files: list[dict[str, str]]


@router.get("")
async def list_checkpoints(user: str = Depends(require_user)) -> list[dict]:
    return file_checkpoints.list_events()


@router.get("/{event_id}")
async def get_checkpoint(event_id: str, user: str = Depends(require_user)) -> dict:
    try:
        return file_checkpoints.get_event(event_id)
    except KeyError:
        raise HTTPException(404, "checkpoint not found")


@router.post("/{event_id}/restore")
async def restore_checkpoint(event_id: str, request: RestoreRequest,
                             user: str = Depends(require_user)) -> dict:
    try:
        accounts.require_machine_access("Restoring files")
    except accounts.MachineAccessDenied as exc:
        raise HTTPException(403, str(exc))
    try:
        return {"restored": file_checkpoints.restore(event_id, request.files)}
    except KeyError:
        raise HTTPException(404, "checkpoint not found")
    except file_checkpoints.Conflict as exc:
        raise HTTPException(409, f"Nothing was restored. {exc}")
