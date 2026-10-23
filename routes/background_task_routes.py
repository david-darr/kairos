"""Owner-only, read-only background work in a chat."""
from fastapi import APIRouter, Depends, HTTPException
from core.middleware import require_user
from core import chat_tasks
from services import background_tasks

router = APIRouter(prefix='/api/chat/background', tags=['chat'])


@router.get('/{session_id}')
async def list_background(session_id: str, user: str = Depends(require_user)):
    background_tasks.require_owner(session_id, user)
    return {'items': background_tasks.list_items(session_id), 'notes': chat_tasks.notes(session_id)}


@router.get('/{session_id}/{item_id:path}')
async def background_detail(session_id: str, item_id: str, user: str = Depends(require_user)):
    background_tasks.require_owner(session_id, user)
    result = background_tasks.detail(session_id, item_id)
    if result is None:
        raise HTTPException(404, 'Background item not found')
    return result
