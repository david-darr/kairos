"""Browse's own requests (vault: "Kairos Browser - Phase 1 (Build Spec)").

Cookie-only (core/cli_access.py COOKIE_ONLY): Browse is the desktop app's own
window, never a paired terminal.

- POST /shared marks a chat as carrying a web page the person shared from
  Browse ("Share this page" in Ask Kairos). The page arrives as an ordinary
  chat attachment; this mark makes the taint rules apply to every turn of
  that chat (services/chat_service.py _taint_turn), exactly as files dropped
  on the notch do. A page is outside content: it may carry instructions
  aimed at the model, and must never be read as the person's own words.
- GET /profile names the signed-in account's Browse profile for the desktop
  app's main process (electron/browser-profiles.js): "default" for the first
  admin (the profile Browse had before accounts), else the account's folder
  id. Each account browses in its own profile.
- /passwords: the password keeper (services/browse_passwords.py), below, including the person's
  "Let bots use saved passwords" switch and the list of bot uses (bots themselves never call these).
"""
import secrets
import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from core import accounts
from core.auth import auth_enabled, auth_manager
from core.middleware import require_user
from services import browse_passwords as passwords
from services import chat_live

router = APIRouter(prefix="/api/browse", tags=["browse"])

SHARED_REASON = "a web page shared from Browse"


class SharedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: Annotated[str, Field(min_length=1, max_length=100)]


@router.post("/shared")
async def mark_shared(body: SharedRequest, user: str = Depends(require_user)) -> dict:
    chat_live.require_session(body.session_id, user)
    from core.session_manager import session_manager
    session_manager.set_untrusted_context(body.session_id, SHARED_REASON)
    return {"status": "marked"}


def _account(user: str) -> str:
    account_id = accounts.account_for_user(user)
    if not account_id:
        raise HTTPException(status_code=401, detail="authentication required")
    return account_id


@router.get("/profile")
async def profile(user: str = Depends(require_user)) -> dict:
    account_id = _account(user)
    return {"profile": "default" if account_id == accounts.local_account() else account_id}


# -- The password keeper (services/browse_passwords.py) --------------------------------------------------
#
# Two kinds of caller. The Browse settings page (the app window, by its sign-in cookie) lists, adds, edits,
# deletes, imports and, after the person re-enters their Kairos password, reveals. The desktop app's main
# process, which watches sign-in forms in Browse tabs, matches, fills and saves: those routes also need the
# secret the desktop app gave this backend when it started (X-Kairos-Desktop, as routes/bot_approval_routes.py
# uses), so a script in the app's page can't pull a site's password without the person's re-entry.

MAX_URL = 4096
UNLOCK_TRIES = 5
UNLOCK_WINDOW = 300
_failed_unlocks: dict[str, list[float]] = {}


def _fail(error: passwords.PasswordError) -> HTTPException:
    return HTTPException(status_code=error.status, detail=str(error))


def _desktop(request: Request, user: str = Depends(require_user)) -> str:
    from routes import bot_approval_routes as desktop
    if not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "This is reachable only from this computer.")
    if request.headers.get("X-JARVIS-Tool-Token"):
        raise HTTPException(403, "A model's tool access cannot do this.")
    supplied = request.headers.get(desktop.DESKTOP_HEADER, "")
    if not desktop.DESKTOP_SECRET or not supplied or not secrets.compare_digest(supplied.encode(), desktop.DESKTOP_SECRET.encode()):
        raise HTTPException(404, "Not found.")
    return user


class PageBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: Annotated[str, Field(min_length=1, max_length=MAX_URL)]


class FillBody(PageBody):
    id: Annotated[str, Field(min_length=1, max_length=40)]


class SignInBody(PageBody):
    username: Annotated[str, Field(max_length=passwords.MAX_FIELD)] = ""
    password: Annotated[str, Field(min_length=1, max_length=passwords.MAX_PASSWORD)]


class EditBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: Optional[Annotated[str, Field(min_length=1, max_length=MAX_URL)]] = None
    username: Optional[Annotated[str, Field(max_length=passwords.MAX_FIELD)]] = None
    password: Optional[Annotated[str, Field(min_length=1, max_length=passwords.MAX_PASSWORD)]] = None


class NeverBody(PageBody):
    never: bool = True


class UnlockBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: Annotated[str, Field(max_length=1000)] = ""


class BotsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allowed: bool


class ImportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    csv: Annotated[str, Field(max_length=passwords.MAX_IMPORT_BYTES)]


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except passwords.PasswordError as error:
        raise _fail(error)


@router.get("/passwords")
async def list_passwords(q: Annotated[str, Query(max_length=200)] = "", user: str = Depends(require_user)) -> dict:
    return {"logins": _run(passwords.list_logins, q), "never": _run(passwords.never_list),
            "unlocked_until": passwords.unlocked_until(_account(user)), "max": passwords.MAX_LOGINS,
            "needs_password": auth_enabled(), "bots_may_use": _run(passwords.bots_allowed),
            "bot_uses": _run(passwords.bot_uses)}


@router.post("/passwords")
async def add_password(body: SignInBody, user: str = Depends(require_user)) -> dict:
    return _run(passwords.save, body.url, body.username, body.password)


@router.get("/passwords/generate")
async def generate_password(user: str = Depends(require_user)) -> dict:
    return {"password": passwords.generate()}


@router.post("/passwords/unlock")
async def unlock_passwords(body: UnlockBody, user: str = Depends(require_user)) -> dict:
    """Re-entering the Kairos password shows saved passwords for five minutes. With accounts off there is
    no password: the app window already proved it is this computer's own, so the click is the confirmation."""
    account_id = _account(user)
    now = time.time()
    tries = [t for t in _failed_unlocks.get(account_id, []) if now - t < UNLOCK_WINDOW]
    if len(tries) >= UNLOCK_TRIES:
        raise HTTPException(429, "Too many tries. Wait a few minutes.")
    ok = auth_manager.verify_password(user, body.password) if auth_enabled() else True
    _failed_unlocks[account_id] = tries if ok else tries + [now]
    return {"unlocked_until": _run(passwords.unlock, account_id, ok)}


@router.post("/passwords/lock")
async def lock_passwords(user: str = Depends(require_user)) -> dict:
    passwords.lock(_account(user))
    return {"locked": True}


@router.post("/passwords/bots")
async def bots_may_use(body: BotsBody, request: Request, user: str = Depends(require_user)) -> dict:
    """The person's "Let bots use saved passwords" switch (David, 2026-11-07). Only the app window's sign-in
    sets it; a model's tool access never can, even alongside a cookie."""
    if request.headers.get("X-JARVIS-Tool-Token"):
        raise HTTPException(403, "A model's tool access cannot do this.")
    return {"bots_may_use": _run(passwords.set_bots_allowed, body.allowed)}


@router.post("/passwords/import")
async def import_passwords(body: ImportBody, user: str = Depends(require_user)) -> dict:
    return _run(passwords.import_csv, body.csv)


@router.post("/passwords/never")
async def never_save(body: NeverBody, user: str = Depends(require_user)) -> dict:
    return _run(passwords.set_never, body.url, body.never)


# The desktop app's main process (electron/browser-passwords.js), for the page in a Browse tab.

@router.post("/passwords/desktop/match")
async def desktop_match(body: PageBody, user: str = Depends(_desktop)) -> dict:
    return _run(passwords.match, body.url)


@router.post("/passwords/desktop/known")
async def desktop_known(body: SignInBody, user: str = Depends(_desktop)) -> dict:
    found = _run(passwords.match, body.url)
    return {"saved": _run(passwords.is_saved, body.url, body.username, body.password), "never": found["never"],
            "update": any(row["username"] == body.username for row in found["logins"])}


@router.post("/passwords/desktop/save")
async def desktop_save(body: SignInBody, user: str = Depends(_desktop)) -> dict:
    return _run(passwords.save, body.url, body.username, body.password)


@router.post("/passwords/desktop/fill")
async def desktop_fill(body: FillBody, user: str = Depends(_desktop)) -> dict:
    return _run(passwords.fill, body.id, body.url)


@router.post("/passwords/desktop/never")
async def desktop_never(body: PageBody, user: str = Depends(_desktop)) -> dict:
    return _run(passwords.set_never, body.url, True)


# One saved sign-in by id. Declared after the fixed paths above so "generate", "unlock" and the rest are
# never read as an id.

@router.patch("/passwords/{login_id}")
async def edit_password(login_id: str, body: EditBody, user: str = Depends(require_user)) -> dict:
    return _run(passwords.update, login_id[:40], url=body.url, username=body.username, password=body.password)


@router.delete("/passwords/{login_id}")
async def delete_password(login_id: str, user: str = Depends(require_user)) -> dict:
    if not _run(passwords.delete, login_id[:40]):
        raise HTTPException(404, "That saved password no longer exists.")
    return {"deleted": True}


@router.post("/passwords/{login_id}/reveal")
async def reveal_password(login_id: str, user: str = Depends(require_user)) -> dict:
    return {"password": _run(passwords.reveal, login_id[:40])}
