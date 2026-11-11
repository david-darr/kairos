"""Auth HTTP surface: status, first-run setup, login/logout, TOTP enrollment.

Only relevant when AUTH_ENABLED=true — see core/auth.py for the single-user
default that skips all of this.
"""
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from core import accounts
from core import auth as auth_module
from core.auth import auth_manager, auth_enabled, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, SINGLE_USER, UI_COOKIE_NAME
from core.auth import ACCOUNT_COLORS, ACCOUNTS_COOKIE_NAME, DEVICE_COOKIE_NAME, MAX_DEVICE_ACCOUNTS, REMEMBER_SHOWN_AFTER_EXPIRY_SECONDS
from core.middleware import get_current_user, require_admin, require_user
from core.constants import INSTANCE
from services.email_service import email_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# -- the device's remembered sign-ins (the account switcher, 2026-11-11) -------------------------------------
# core/auth.py explains the model: the kairos_device cookie is the device's secret (a bearer secret like the session
# cookie), rotated on every change; the server keeps one remembered row per account signed in on the device;
# jarvis_session holds the open account's session. Switching opens a fresh session for the chosen account and
# closes every session the device held, so the device only ever holds one.

def _device_secret(request: Request) -> str | None:
    value = request.cookies.get(DEVICE_COOKIE_NAME) or ""
    return value if auth_module._TOKEN_SHAPE.match(value) else None


def _store_device(response: Response, device: str | None) -> None:
    if device:
        response.set_cookie(DEVICE_COOKIE_NAME, device, httponly=True, samesite="lax",
                            max_age=SESSION_TTL_SECONDS + REMEMBER_SHOWN_AFTER_EXPIRY_SECONDS)
    else:
        response.delete_cookie(DEVICE_COOKIE_NAME)
    response.delete_cookie(ACCOUNTS_COOKIE_NAME)  # the first build's cookie, never needed again


def _store_session(response: Response, token: str) -> None:
    expires_at = auth_manager._sessions.get(token, {}).get("expires_at", time.time() + SESSION_TTL_SECONDS)
    response.set_cookie(SESSION_COOKIE_NAME, token, httponly=True, samesite="lax", max_age=max(1, int(expires_at - time.time())))


def _device(request: Request) -> tuple[str | None, str | None, bool]:
    """This device's secret (after bringing older sign-ins onto it), the open session if valid, and whether the
    secret changed (so the caller must store it)."""
    from core import mobile_activity
    device = _device_secret(request)
    session = request.cookies.get(SESSION_COOKIE_NAME)
    open_user = auth_manager.validate_session(session) if session else None
    legacy = [t for t in (request.cookies.get(ACCOUNTS_COOKIE_NAME) or "").split(".") if auth_module._TOKEN_SHAPE.match(t)][:20]
    before = auth_manager.remember_of(session) if open_user else None
    adopted = auth_manager.device_adopt(device, session if open_user else None, legacy)
    if open_user and not before:
        remember = auth_manager.remember_of(session)
        if remember:  # its push enrollment follows it (core/auth.py notification_session_valid)
            mobile_activity.rebind(mobile_activity.binding(session), mobile_activity.binding(remember))
    return adopted, (session if open_user else None), adopted != device


def _open_remember(session: str | None) -> str | None:
    return auth_manager.remember_of(session) if session else None


def _from_the_app(request: Request) -> None:
    """Cross-site request forgery guard for the switcher's routes: the app's own pages send X-Kairos-Switch (a
    custom header another site's page cannot add without a CORS grant this app never gives), and a browser's
    Origin and Sec-Fetch-Site, when sent, must say this same site."""
    if request.headers.get("x-kairos-switch") != "1":
        raise HTTPException(status_code=403, detail="This request must come from the Kairos app.")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(status_code=403, detail="This request must come from the Kairos app.")
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="This request must come from the Kairos app.")


def _sign_in_here(request: Request, response: Response, username: str) -> None:
    """A password sign-in on this device: the account joins the device's switcher and becomes the open one."""
    device, session, _ = _device(request)
    others = [r for r in auth_manager.device_accounts(device) if r["username"] != username]
    if len(others) >= MAX_DEVICE_ACCOUNTS:
        raise HTTPException(status_code=400, detail=f"This device already has {MAX_DEVICE_ACCOUNTS} accounts signed in. "
                                                    "Sign out of one first.")
    device, token = auth_manager.device_sign_in(device, username, session)
    _store_session(response, token)
    _store_device(response, device)


def _switch_refused(status: int, code: str, detail: str, **extra) -> JSONResponse:
    return JSONResponse({"detail": detail, "code": code, **extra}, status_code=status)


class SwitchRequest(BaseModel):
    username: str
    pin: str | None = None


@router.get("/device-accounts")
async def device_accounts(request: Request, response: Response) -> dict:
    """The accounts signed in on this device, for the switcher: names, colours, which is open, which need the
    password again, which ask a PIN. Only this device's own; never a list of the install's accounts."""
    if not auth_enabled():
        return {"enabled": False, "accounts": [], "max": MAX_DEVICE_ACCOUNTS, "colors": list(ACCOUNT_COLORS)}
    device, session, changed = _device(request)
    if changed or request.cookies.get(ACCOUNTS_COOKIE_NAME) is not None:
        _store_device(response, device)
    remember = _open_remember(session)
    return {"enabled": True, "max": MAX_DEVICE_ACCOUNTS, "colors": list(ACCOUNT_COLORS), "accounts": [
        {"username": r["username"], "color": auth_manager.account_color(r["username"]), "active": r["id"] == remember,
         "expired": r["expired"], "pin": auth_manager.has_switch_pin(r["username"])} for r in auth_manager.device_accounts(device)]}


@router.post("/switch")
async def switch_account(body: SwitchRequest, request: Request) -> Response:
    """Makes another account signed in on this device the open one, with no password: only an account this
    device remembers, after its PIN if it has one. An expired remembered sign-in asks for the password again."""
    if not auth_enabled():
        raise HTTPException(status_code=400, detail="Accounts are off: there is only this computer's user.")
    _from_the_app(request)
    device, session, changed = _device(request)
    current = next((r for r in auth_manager.device_accounts(device) if r["id"] == _open_remember(session)), None)
    if current and current["username"] == body.username:
        answer = JSONResponse({"username": body.username, "color": auth_manager.account_color(body.username)})
        if changed:
            _store_device(answer, device)
        return answer
    result = auth_manager.device_switch(device, body.username, body.pin, session)
    if result["ok"]:
        answer = JSONResponse({"username": body.username, "color": auth_manager.account_color(body.username)})
        _store_session(answer, result["session"])
        _store_device(answer, result["device"])
        return answer
    reason = result["reason"]
    if reason == "absent":
        refused = JSONResponse({"detail": "That account is not signed in on this device."}, status_code=404)
    elif reason == "expired":
        refused = _switch_refused(401, "password_required", "That sign-in has expired. Enter the password to sign in again.")
    elif reason == "forget":
        refused = _switch_refused(401, "password_required", "Too many wrong PINs. Enter the password to sign in again.")
    elif reason == "locked":
        refused = _switch_refused(429, "pin_locked", f"Too many wrong PINs. Try again in {result['retry_after']} seconds.",
                                  retry_after=result["retry_after"])
    elif reason == "wrong":
        refused = _switch_refused(403, "pin_wrong", "That PIN is not right.", tries_left=result["tries_left"])
    else:
        refused = _switch_refused(403, "pin_required", "Enter this account's PIN.")
    if changed:
        _store_device(refused, device)
    return refused


class SignOutAccountRequest(BaseModel):
    username: str


@router.post("/sign-out-account")
async def sign_out_account(body: SignOutAccountRequest, request: Request, response: Response) -> dict:
    """Signs one account out of this device only; the others stay signed in."""
    from core import mobile_activity
    _from_the_app(request)
    device, session, _ = _device(request)
    rows = auth_manager.device_accounts(device)
    target = next((r for r in rows if r["username"] == body.username), None)
    if target is None:
        raise HTTPException(status_code=404, detail="That account is not signed in on this device.")
    was_open = target["id"] == _open_remember(session)
    mobile_activity.revoke(session_binding=mobile_activity.binding(target["id"]))
    _store_device(response, auth_manager.device_sign_out(device, body.username))
    if was_open:
        response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True, "was_open": was_open, "remaining": [r["username"] for r in rows if r["id"] != target["id"]]}


@router.post("/logout-all")
async def logout_all(request: Request, response: Response) -> dict:
    """Signs every account out of this device."""
    from core import mobile_activity
    _from_the_app(request)
    device, session, _ = _device(request)
    for row in auth_manager.device_accounts(device):
        mobile_activity.revoke(session_binding=mobile_activity.binding(row["id"]))
    auth_manager.device_sign_out(device)
    if session:
        mobile_activity.revoke(session_binding=mobile_activity.binding(session))
        auth_manager.delete_session(session)
    response.delete_cookie(SESSION_COOKIE_NAME)
    _store_device(response, None)
    return {"ok": True}


class AccountColorRequest(BaseModel):
    color: str


@router.put("/account/color")
async def set_account_color(body: AccountColorRequest, request: Request, user: str = Depends(require_user)) -> dict:
    """My account: this account's colour (its avatar ring, the switcher, the app's top edge)."""
    _from_the_app(request)
    try:
        auth_manager.set_account_color(user, body.color)
    except KeyError:
        raise HTTPException(status_code=400, detail="Accounts are off: there is no account colour to set.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "color": body.color}


class SwitchPinRequest(BaseModel):
    password: str
    pin: str | None = None


@router.put("/account/switch-pin")
async def set_switch_pin(body: SwitchPinRequest, request: Request, user: str = Depends(require_user)) -> dict:
    """My account: set (4 to 8 digits) or clear (no pin) the PIN asked when switching into this account on a
    device. The password is asked for either way, so an open, unattended app cannot change it."""
    _from_the_app(request)
    if not auth_manager.verify_password(user, body.password):
        raise HTTPException(status_code=401, detail="That password is not right.")
    try:
        auth_manager.set_switch_pin(user, body.pin or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "switch_pin": auth_manager.has_switch_pin(user)}


class SetupRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str
    totp_code: str | None = None


@router.get("/status")
async def status(request: Request) -> dict:
    user = get_current_user(request)
    return {
        "auth_enabled": auth_enabled(),
        "setup_required": auth_enabled() and not auth_manager.has_any_users(),
        "username": user,
        "is_admin": auth_manager.is_admin(user) if user else False,
        # Whether this account may use this computer's shell and files (admins always can); the UI hides the
        # pieces that need it (Forge, folder pickers) from accounts without it.
        "machine_access": auth_manager.has_machine_access(user) if user else False,
        # True for every account but the first admin's: each signs in to its own Claude and Codex (the first
        # admin keeps this computer's sign-in), so the model guide says "your own" sign-in.
        "own_sign_in": bool(user) and auth_enabled() and auth_manager.account_id(user) != auth_manager.first_admin_account(),
        # Account > Two-factor shows whether it is on and offers only the matching action.
        "totp_enabled": bool(user) and auth_manager.totp_enabled(user),
        # The account switcher: this account's colour and whether switching into it asks a PIN.
        "color": auth_manager.account_color(user) if user and auth_enabled() else None,
        "switch_pin": bool(user) and auth_enabled() and auth_manager.has_switch_pin(user),
        # Whether a real "Switch User" is even meaningful right now (David's
        # ask 2026-08-31) — a plain boolean, not the user list itself:
        # GET /users is admin-only (enumerating accounts is a real privacy
        # leak on a shared machine), but "does more than one account exist"
        # is safe to expose to anyone so the sidebar can gate the option.
        "other_users_exist": auth_enabled() and len(auth_manager.list_users()) > 1,
        # Accounts off, and this request is not the app's own window (see
        # core/auth.py's UI_SECRET): the page says to open Kairos from the app.
        "local_access_locked": not auth_enabled() and user is None,
        # "" for the real app; a development copy's name otherwise (the DEV badge).
        "instance": INSTANCE,
    }


@router.post("/ui-code")
async def ui_code(request: Request) -> dict:
    """A one-time code that hands the app window's access to the person's
    own browser (the tray's "Open in browser"). Only a request that already
    holds that access can mint one."""
    if auth_enabled() or not auth_module.UI_SECRET:
        raise HTTPException(status_code=404, detail="not needed: sign in, or the app is already open to local requests")
    if get_current_user(request) != SINGLE_USER:
        raise HTTPException(status_code=401, detail="authentication required")
    return {"code": auth_module.mint_ui_code()}


@router.get("/ui-handoff")
async def ui_handoff(code: str = "") -> Response:
    """Redeem a code from /ui-code: sets the app's access cookie in this
    browser and opens the app. Single use, 60 seconds."""
    if auth_enabled() or not auth_module.UI_SECRET or not auth_module.redeem_ui_code(code):
        raise HTTPException(status_code=403, detail="this link has expired; use Open in browser from the Kairos tray again")
    response = RedirectResponse("/", status_code=303)
    # A session cookie (never written to disk by the browser), not readable
    # by page scripts, and never sent on a request another site starts.
    response.set_cookie(UI_COOKIE_NAME, auth_module.UI_SECRET, httponly=True, samesite="strict", path="/")
    return response


@router.post("/setup")
async def setup(body: SetupRequest, request: Request, response: Response) -> dict:
    if not auth_enabled():
        raise HTTPException(status_code=400, detail="AUTH_ENABLED is false — no setup needed")
    if auth_manager.has_any_users():
        raise HTTPException(status_code=400, detail="setup already completed")
    auth_manager.create_user(body.username, body.password, is_admin=True)
    _sign_in_here(request, response, body.username)
    return {"username": body.username, "is_admin": True}


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response) -> dict:
    if not auth_enabled():
        raise HTTPException(status_code=400, detail="AUTH_ENABLED is false — no login needed")
    if not auth_manager.verify_password(body.username, body.password):
        raise HTTPException(status_code=401, detail="invalid username or password")
    if auth_manager.totp_enabled(body.username):
        if not body.totp_code or not auth_manager.verify_totp(body.username, body.totp_code):
            raise HTTPException(status_code=401, detail="invalid or missing 2FA code")
    # Joins this device's switcher (signing in with another account open is "Add another account").
    _sign_in_here(request, response, body.username)
    return {"username": body.username, "is_admin": auth_manager.is_admin(body.username)}


class ForgotPasswordRequest(BaseModel):
    username: str
    email: str


# Same wording every time, on every branch below (unknown username, email
# that doesn't match any configured account, real send failure, or a
# genuine success) - a forgot-password endpoint that returns different
# responses for "no such user" vs "wrong email" is a free username/email
# enumeration oracle. Logged-out by design, so it can't be require_user-gated.
_FORGOT_PASSWORD_GENERIC_RESPONSE = {
    "ok": True,
    "message": "If that username and email are both recognized, a reset code has been sent.",
}


@router.post("/forgot-password")
async def forgot_password(body: ForgotPasswordRequest) -> dict:
    if not auth_enabled():
        raise HTTPException(status_code=400, detail="AUTH_ENABLED is false — no accounts to reset")

    entered_email = body.email.strip().lower()
    # Nobody is signed in here: look in the install's own mail (the first admin's account), where it always was.
    with accounts.as_account(accounts.local_account()):
        account = next(
            (a for a in email_service.list_accounts() if a.get("email", "").strip().lower() == entered_email),
            None,
        )
    if account is None:
        return _FORGOT_PASSWORD_GENERIC_RESPONSE

    code = auth_manager.create_password_reset(body.username.strip())
    if not code:
        return _FORGOT_PASSWORD_GENERIC_RESPONSE

    try:
        with accounts.as_account(accounts.local_account()):
            email_service.send_message(
                account["id"],
                to=account["email"],
                subject="Kairos password reset code",
                body=(
                    f"Your Kairos password reset code is: {code}\n\n"
                    "This code expires in 15 minutes and can only be used once. "
                    "If you didn't request this, you can safely ignore this email."
                ),
            )
    except Exception:
        # Still the generic response - a real send failure (bad SMTP creds,
        # network blip) shouldn't tell an attacker their guess was closer
        # than a genuinely unknown username/email would have been.
        logger.exception("forgot_password: failed to send reset code via account %s", account["id"])

    return _FORGOT_PASSWORD_GENERIC_RESPONSE


class ResetPasswordRequest(BaseModel):
    username: str
    code: str
    new_password: str


@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest) -> dict:
    if not auth_enabled():
        raise HTTPException(status_code=400, detail="AUTH_ENABLED is false — no accounts to reset")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Use a password of at least 8 characters.")
    ok = auth_manager.redeem_password_reset(body.username.strip(), body.code.strip(), body.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail="That code is invalid, expired, or already used.")
    return {"ok": True}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    """Signs the open account out of this device; other accounts signed in on it stay (the switcher lists them)."""
    from core import mobile_activity
    token = request.cookies.get(SESSION_COOKIE_NAME)
    device = _device_secret(request) if auth_enabled() else None
    remember = auth_manager.remember_of(token)
    mobile_activity.revoke(session_binding=mobile_activity.binding(token))
    left = [r for r in auth_manager.device_accounts(device) if r["id"] != remember]
    if remember and any(r["id"] == remember for r in auth_manager.device_accounts(device)):
        mobile_activity.revoke(session_binding=mobile_activity.binding(remember))
        name = auth_manager._sessions.get(remember, {}).get("username")
        _store_device(response, auth_manager.device_sign_out(device, name))
    elif remember:
        mobile_activity.revoke(session_binding=mobile_activity.binding(remember))
        auth_manager._drop([remember])
    if token:
        auth_manager.delete_session(token)
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True, "remaining": [r["username"] for r in left]}


class TotpVerifyRequest(BaseModel):
    code: str


@router.post("/onboarding-complete")
async def onboarding_complete(user: str = Depends(require_user)) -> dict:
    """A member finishing the first-run guide: marks it done for this account only (onboarding_complete is a
    "My account" setting, kept in the account's own file). Admins use /api/settings/onboarding-complete."""
    from core import settings as settings_store
    settings_store.update_settings(onboarding_complete=True)
    return {"ok": True}


@router.post("/totp/enroll")
async def totp_enroll(user: str = Depends(require_user)) -> dict:
    uri = auth_manager.start_totp_enrollment(user)
    return {"provisioning_uri": uri}


@router.post("/totp/confirm")
async def totp_confirm(body: TotpVerifyRequest, user: str = Depends(require_user)) -> dict:
    ok = auth_manager.confirm_totp_enrollment(user, body.code)
    if not ok:
        raise HTTPException(status_code=400, detail="invalid code")
    return {"ok": True}


@router.post("/totp/disable")
async def totp_disable(user: str = Depends(require_user)) -> dict:
    auth_manager.disable_totp(user)
    return {"ok": True}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
async def change_password(body: ChangePasswordRequest, request: Request, user: str = Depends(require_user)) -> dict:
    """Self-service password change (Settings > Account, David's ask
    2026-08-31, matching Odysseus's Account panel)."""
    if not auth_manager.verify_password(user, body.current_password):
        raise HTTPException(status_code=401, detail="current password is incorrect")
    auth_manager.change_password(user, body.new_password)
    # Every other sign-in of this account ends, on every device (sessions and remembered sign-ins); this one stays.
    auth_manager.revoke_other_sign_ins(user, request.cookies.get(SESSION_COOKIE_NAME))
    return {"ok": True}


# -- admin: user management (Settings > Admin > Users) ----------------------

@router.get("/users")
async def list_users(user: str = Depends(require_admin)) -> list[dict]:
    return auth_manager.list_users()


class CreateUserRequest(BaseModel):
    username: str
    password: str
    is_admin: bool = False


@router.post("/users")
async def create_user(body: CreateUserRequest, user: str = Depends(require_admin)) -> dict:
    try:
        auth_manager.create_user(body.username, body.password, is_admin=body.is_admin)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # A new account starts with its own Kip (Multi-Account group 4, decision D7) and the bundled skills (group 7).
    from core import accounts
    from services import front_desk, skills_service
    with accounts.as_account(auth_manager.account_id(body.username)):
        try:
            skills_service._seed_account(auth_manager.account_id(body.username))
        except Exception:
            logging.getLogger(__name__).exception("the new account's skills could not be seeded")
        try:
            front_desk.ensure()
        except Exception:
            logging.getLogger(__name__).exception("the new account's front desk could not be set up")
    return {"ok": True}


class SetAdminRequest(BaseModel):
    is_admin: bool


@router.post("/users/{username}/admin")
async def set_user_admin(username: str, body: SetAdminRequest, user: str = Depends(require_admin)) -> dict:
    try:
        auth_manager.set_admin(username, body.is_admin)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


class SetMachineAccessRequest(BaseModel):
    enabled: bool


@router.put("/users/{username}/machine-access")
async def set_user_machine_access(username: str, body: SetMachineAccessRequest, user: str = Depends(require_admin)) -> dict:
    """Let one account's chats and bots use this computer's shell and files (admins always can)."""
    try:
        auth_manager.set_machine_access(username, body.enabled)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "machine_access": auth_manager.has_machine_access(username)}


class AdminResetPasswordRequest(BaseModel):
    new_password: str


@router.post("/users/{username}/password")
async def admin_reset_password(username: str, body: AdminResetPasswordRequest, user: str = Depends(require_admin)) -> dict:
    """An admin sets a new password for a member who forgot theirs. Never for an admin account or one's own
    (those use Settings > Account), and the member's open sessions end."""
    if username == user:
        raise HTTPException(status_code=400, detail="Use Account settings to change your own password.")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="Use a password of at least 8 characters.")
    if username not in {u["username"] for u in auth_manager.list_users()}:
        raise HTTPException(status_code=404, detail="user not found")
    if auth_manager.is_admin(username):
        raise HTTPException(status_code=400, detail="Admin passwords can only be changed by that admin in Account settings.")
    auth_manager.change_password(username, body.new_password)
    auth_manager.drop_sessions(username)
    return {"ok": True}


@router.delete("/users/{username}")
async def delete_user(username: str, user: str = Depends(require_admin)) -> dict:
    if username == user:
        raise HTTPException(status_code=400, detail="can't delete your own account while logged in as it")
    try:
        auth_manager.delete_user(username)
        from core import mobile_activity
        mobile_activity.revoke(owner=username)
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}
