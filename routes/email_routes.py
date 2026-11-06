"""Email account CRUD + connection test + inbox list + send — the Email tab."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core import builtin_tasks, email_triage
from core.auth import auth_manager
from core.middleware import require_user
from services.email_service import email_service

router = APIRouter(prefix="/api/email", tags=["email"])


class CreateAccountRequest(BaseModel):
    email: str
    password: str
    imap_host: str
    imap_port: int = 993
    smtp_host: str
    smtp_port: int = 465
    smtp_security: str = "ssl"


class SendRequest(BaseModel):
    to: str
    subject: str
    body: str


def _can_see(account: dict, user: str) -> bool:
    # Members see only accounts they added; accounts with no owner (made
    # before ownership) belong to admins. Admins, and the single local user,
    # see all.
    return auth_manager.is_admin(user) or account.get("owner") == user


def owned_account(account_id: str, user: str = Depends(require_user)) -> str:
    """Shared dependency for the /accounts/{account_id} routes: 404 when the
    account exists but is not the caller's (a missing id keeps its old answer)."""
    account = email_service.get_account(account_id)
    if account is not None and not _can_see(account, user):
        raise HTTPException(status_code=404, detail="account not found")
    return account_id


def _triage_for(user: str, payload: dict) -> dict:
    if auth_manager.is_admin(user):
        return payload
    mine = {a["email"] for a in email_service.list_accounts() if _can_see(a, user)}
    items = [i for i in payload.get("items", []) if i.get("account") in mine]
    return {**payload, "items": items}


@router.get("/accounts")
async def list_accounts(user: str = Depends(require_user)) -> list[dict]:
    return [a for a in email_service.list_accounts() if _can_see(a, user)]


# Every address agents can send from (send_email), Google sign-ins included,
# so the Email tab is where people look for and add sending accounts.
@router.get("/sending-accounts")
async def sending_accounts(user: str = Depends(require_user)) -> dict:
    from core import email_send, google_workspace
    return {"accounts": email_send.accounts(user), "google_configured": google_workspace.status(user)["configured"]}


# Daily importance triage (David's ask 2026-09-06). Registered before the
# /accounts/{account_id} routes below so "triage" can't be captured as an
# account id by the dynamic path.
@router.get("/triage")
async def get_triage(user: str = Depends(require_user)) -> dict:
    return _triage_for(user, email_triage.load())


@router.post("/triage/run")
async def run_triage(user: str = Depends(require_user)) -> dict:
    """Run the triage pass now instead of waiting for the 05:50 task — the
    same code the scheduled task runs, so the button can't drift from it."""
    try:
        summary = await builtin_tasks.BUILTIN_TASKS["triage_email"]["run"]()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"triage failed: {str(e)[:300]}")
    return {"summary": summary, **_triage_for(user, email_triage.load())}


@router.post("/accounts")
async def create_account(body: CreateAccountRequest, user: str = Depends(require_user)) -> dict:
    return email_service.create_account(
        body.email, body.password, body.imap_host, body.imap_port,
        body.smtp_host, body.smtp_port, body.smtp_security, owner=user,
    )


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str = Depends(owned_account), user: str = Depends(require_user)) -> dict:
    email_service.delete_account(account_id)
    return {"ok": True}


@router.post("/accounts/{account_id}/test")
async def test_account(account_id: str = Depends(owned_account), user: str = Depends(require_user)) -> dict:
    try:
        return email_service.test_connection(account_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")


@router.get("/accounts/{account_id}/messages")
async def list_messages(folder: str = "INBOX", limit: int = Query(20, ge=1, le=200), account_id: str = Depends(owned_account), user: str = Depends(require_user)) -> list[dict]:
    try:
        return email_service.list_messages(account_id, folder, limit)
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IMAP error: {e}")


@router.post("/accounts/{account_id}/send")
async def send_message(body: SendRequest, account_id: str = Depends(owned_account), user: str = Depends(require_user)) -> dict:
    try:
        email_service.send_message(account_id, body.to, body.subject, body.body)
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SMTP error: {e}")
    return {"ok": True}
