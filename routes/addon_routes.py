"""Install and manage optional first-party Tool Store packages."""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Literal

from core import addons, custom_tabs, tab_hooks
from core.middleware import require_admin, require_user

router = APIRouter(prefix='/api/addons', tags=['addons'])


@router.get('')
def catalog(user: str = Depends(require_user)):
    return addons.catalog()


class Change(BaseModel):
    action: Literal['install', 'enable', 'disable', 'remove']


@router.post('/{ident}')
async def change(ident: str, body: Change, request: Request, user: str = Depends(require_admin)):
    try:
        result = addons.change(ident, body.action)
        if ident == 'roblox' and result['enabled']:
            result['restart_required'] = result.get('restart_required', False) or not custom_tabs.mount_one(request.app, 'roblox')
        await tab_hooks.reconcile()
        return result
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('/{ident}/files/{relative:path}')
def asset(ident: str, relative: str, user: str = Depends(require_user)):
    # Runtime code, skills and private state are not browser resources.
    if not relative.startswith('static/') or not relative.endswith(('.js', '.css')):
        raise HTTPException(404)
    try:
        path = addons.file(ident, relative)
    except (ValueError, OSError):
        raise HTTPException(404)
    return FileResponse(path, media_type='text/javascript' if relative.endswith('.js') else 'text/css', headers={'Cache-Control': 'no-store'})
