"""Setup, with polled installation progress and broker approval. Signing in and connecting are each account's own;
installing Codex stays admin."""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from core import accounts
from core.middleware import require_admin, require_user
from services import model_setup

router = APIRouter(prefix='/api/model-setup', tags=['model-setup'], dependencies=[Depends(require_user)])


class ConnectionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['claude', 'codex', 'antigravity', 'claude_cli', 'codex_cli', 'antigravity_cli', 'api']
    provider: Literal['openai', 'anthropic', 'openrouter', 'google'] | None = None
    key: str = Field(default='', max_length=4096)


@router.get('/status')
async def status():
    return await asyncio.to_thread(model_setup.status)


@router.post('/codex/install', dependencies=[Depends(require_admin)])
async def install():
    try:
        return model_setup.begin_install()
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.get('/codex/install/{job_id}', dependencies=[Depends(require_admin)])
async def progress(job_id: str):
    try:
        return model_setup.install_progress(job_id)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error


@router.post('/codex/install/{job_id}/cancel', dependencies=[Depends(require_admin)])
async def cancel(job_id: str):
    try:
        return model_setup.cancel_install(job_id)
    except KeyError as error:
        raise HTTPException(404, str(error)) from error


@router.post('/sign-in/{kind}')
async def sign_in(kind: Literal['claude', 'codex']):
    try:
        accounts.require_machine_access('Signing in opens a window on this computer')
    except accounts.MachineAccessDenied as error:
        raise HTTPException(403, str(error)) from error
    try:
        return await asyncio.to_thread(model_setup.open_sign_in, kind)
    except (ValueError, OSError) as error:
        raise HTTPException(400, str(error)) from error


@router.get('/sign-in/{kind}/wait')
async def wait(kind: Literal['claude', 'codex'], timeout: float = 120):
    return await model_setup.wait_signed_in(kind, timeout)


@router.post('/api-key/test')
async def test_key(body: ConnectionRequest):
    try:
        return await model_setup.test_api_key(body.provider, body.key)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/connections')
async def connection(body: ConnectionRequest):
    try:
        return await model_setup.create_connection(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
