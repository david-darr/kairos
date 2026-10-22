"""Pairing and managing Kairos CLI terminals (core/cli_access.py).

- POST /api/auth/cli-pair asks to pair. Unauthenticated by design: it is the
  only way in for a terminal, and all it can do is raise a prompt in the app
  window. Loopback only and rate limited.
- POST /api/auth/cli-pair/{id}/claim collects the answer, for the holder of
  the claim secret only.
- POST /api/auth/cli/heartbeat and DELETE /api/auth/cli/session are the
  terminal's own: "still here" and "goodbye".
- GET /api/auth/cli/terminals and DELETE /api/auth/cli/terminals/{id} are
  Settings > Permissions, for the app window only.
"""
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from core import cli_access

router = APIRouter(prefix="/api/auth", tags=["cli"])


class PairBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pid: int = Field(default=0, ge=0, lt=2**31)
    terminal: Annotated[str, Field(max_length=200)] = ""


class ClaimBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    claim: Annotated[str, Field(min_length=1, max_length=200)]
    wait: float = Field(default=25.0, ge=0, le=30)


def _refused(error: cli_access.PairRefused):
    return HTTPException(status_code=error.status, detail=error.detail)


@router.post("/cli-pair")
async def start_pair(body: PairBody, request: Request) -> dict:
    try:
        return cli_access.start_pair(body.pid, body.terminal, request)
    except cli_access.PairRefused as error:
        raise _refused(error)


@router.post("/cli-pair/{request_id}/claim")
async def claim_pair(request_id: str, body: ClaimBody) -> dict:
    try:
        return await cli_access.claim(request_id, body.claim, body.wait)
    except cli_access.PairRefused as error:
        raise _refused(error)


def _terminal(request: Request) -> cli_access.Terminal:
    if not cli_access.request_allowed(request):
        raise HTTPException(status_code=401, detail="This terminal is not paired. Run kairos again to pair it.")
    record = cli_access.current(request)
    if record is None:
        raise HTTPException(status_code=401, detail="This terminal is not paired. Run kairos again to pair it.")
    return record


@router.post("/cli/heartbeat")
async def heartbeat(request: Request) -> dict:
    record = _terminal(request)
    return {"ok": True, "expires_at": record.expires_at, "terminal_id": record.id}


@router.delete("/cli/session")
async def goodbye(request: Request) -> dict:
    _terminal(request)
    cli_access.revoke_token(request.headers.get(cli_access.HEADER, ""), "the terminal closed")
    return {"ok": True}


def _app_window(request: Request) -> None:
    if not cli_access.is_app_window(request):
        raise HTTPException(status_code=401, detail="Open this in the Kairos app.")


@router.get("/cli/terminals")
async def terminals(request: Request) -> dict:
    _app_window(request)
    return {"terminals": cli_access.list_terminals(), "pairing": cli_access.pairing_needed()}


@router.delete("/cli/terminals/{terminal_id}")
async def revoke_terminal(terminal_id: str, request: Request) -> dict:
    _app_window(request)
    if not cli_access.revoke(terminal_id):
        raise HTTPException(status_code=404, detail="No such terminal.")
    return {"ok": True}
