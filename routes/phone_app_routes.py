"""The Kairos iPhone app's own routes: pairing, "who am I", the paired phones, Home at a glance and native push
(specs/phone-api.md; the contract both sides build to is docs/PHONE-API.md in the kairos-ios repository).

These sit under /api/phone beside the telephone connection (routes/phone_routes.py, Twilio and Telnyx); the two
share a prefix and nothing else. Everything else the phone app does goes through the same routes the web app
uses, signed in with its token (core/middleware.py, core/phone_devices.py).

Who may call what:
- pair/start: a signed-in browser session only. Never a phone token (core/phone_devices.py DESKTOP_ONLY): a
  stolen token must not be able to pair a second phone.
- pair/claim: nobody signed in. The six-digit code is the only thing it trusts, and wrong tries are limited.
- session, devices, home: any signed-in account, for its own data only.
- push/register, push/activity: a paired phone only, for itself.
- push/relay: an admin in a browser session (where pushes are sent is a setting of this whole Kairos).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import BaseModel, Field

from core import mobile_activity, phone_devices, phone_push
from core import settings as settings_store
from core.auth import auth_manager
from core.middleware import phone_device, require_admin, require_user
from services import phone_home

router = APIRouter(prefix="/api/phone", tags=["phone-app"])
_DEVICE_ID = Path(pattern="^d_[0-9a-f]{24}$")


def _from_this_app(request: Request) -> None:
    """For the routes a browser session changes things through: a request another site's page starts is refused.
    The session cookie is SameSite=Lax, which already keeps it off such a request; this is the second lock."""
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(status_code=403, detail="This request must come from the Kairos app.")
    if request.headers.get("sec-fetch-site") not in (None, "same-origin", "none"):
        raise HTTPException(status_code=403, detail="This request must come from the Kairos app.")


def _account(username: str) -> dict:
    return {"username": username, "is_admin": auth_manager.is_admin(username), "color": auth_manager.account_color(username)}


_version: Optional[str] = None


def _server() -> dict:
    """This Kairos, for the phone's "connected to" line: the app's name and its version (electron/package.json,
    the one place the version is written; KAIROS_VERSION overrides it for a build that sets it)."""
    global _version
    if _version is None:
        import json
        import os
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "electron", "package.json")
        try:
            with open(path, encoding="utf-8") as handle:
                found = json.load(handle).get("version")
        except (OSError, ValueError):
            found = None
        _version = str(os.environ.get("KAIROS_VERSION") or found or "unknown")
    return {"name": "Kairos", "version": _version}


def _this_phone(request: Request) -> dict:
    device = phone_device(request)
    if device is None:
        raise HTTPException(status_code=403, detail="Only a paired phone can do this.")
    return device


# -- pairing ------------------------------------------------------------------------------------------------

@router.post("/pair/start")
async def pair_start(request: Request, response: Response, user: str = Depends(require_user)) -> dict:
    """Make a pairing code for the signed-in account: six digits, ten minutes, one use. A new code cancels the
    account's old one. `address` is where a phone reaches this Kairos, or null while remote access is off."""
    _from_this_app(request)
    if phone_device(request) is not None:   # the middleware already refuses this; never rely on one lock
        raise HTTPException(status_code=403, detail=phone_devices.DESKTOP_ONLY_MESSAGE)
    try:
        code, expires_at = phone_devices.start_pairing(user)
    except phone_devices.PairError as error:
        raise HTTPException(status_code=error.status, detail=error.detail)
    response.headers["Cache-Control"] = "no-store"
    return {"code": code, "expires_at": phone_home.iso(expires_at), "address": _remote_address()}


def _remote_address() -> Optional[str]:
    from core import remote_access
    return remote_access.current_url()


class ClaimBody(BaseModel):
    # Bounds only: a code of the wrong shape is a wrong code (and counts as a wrong try), never a 422 that
    # would tell a caller what a code looks like without spending a try.
    code: str = Field(max_length=64)
    device_name: str = Field(default="", max_length=120)
    device_model: str = Field(default="", max_length=80)
    app_version: str = Field(default="", max_length=40)


@router.post("/pair/claim")
async def pair_claim(body: ClaimBody, request: Request, response: Response) -> dict:
    """The phone's side of pairing. No sign-in: the code is the proof. Answers the token, once."""
    address = request.client.host if request.client else None
    try:
        made = phone_devices.claim(body.code.strip(), address, body.device_name, body.device_model, body.app_version)
    except phone_devices.PairError as error:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
        raise HTTPException(status_code=error.status, detail=error.detail, headers=headers)
    response.headers["Cache-Control"] = "no-store"
    device = made["device"]
    return {"token": made["token"], "device_id": device["id"], "account": _account(device["username"]), "server": _server()}


# -- the signed-in phone ------------------------------------------------------------------------------------

@router.get("/session")
async def session(request: Request, user: str = Depends(require_user)) -> dict:
    """Who am I, and is the token still good (a removed or unknown token is answered 401 before this runs)."""
    device = phone_device(request)
    return {"account": _account(user), "device_id": device["id"] if device else None, "server": _server()}


@router.get("/devices")
async def devices(request: Request, user: str = Depends(require_user)) -> dict:
    """The account's own paired phones. `current` marks the phone that is asking."""
    asking = phone_device(request)
    return {"devices": [{"id": d["id"], "name": d["name"], "model": d["model"], "created_at": phone_home.iso(d["created_at"]),
                         "last_seen_at": phone_home.iso(d["last_seen_at"]), "current": bool(asking and asking["id"] == d["id"])}
                        for d in phone_devices.devices_for(user)]}


@router.delete("/devices/{device_id}", status_code=204)
async def unpair(request: Request, device_id: str = _DEVICE_ID, user: str = Depends(require_user)) -> Response:
    """Unpair one of the account's own phones. Its token stops working at once, its streams and websockets
    close, and its push registration goes. Another account's phone answers 404, like one that never existed."""
    if phone_device(request) is None:
        _from_this_app(request)
    if not phone_devices.revoke(user, device_id):
        raise HTTPException(status_code=404, detail="That phone is not paired to this account.")
    return Response(status_code=204)


@router.get("/home")
async def home(user: str = Depends(require_user)) -> dict:
    """Usage per model plan, the next event, how many things need you and how many chats are working."""
    return await phone_home.summary(user)


# -- native push --------------------------------------------------------------------------------------------

class PushRegistration(BaseModel):
    apns_token: str = Field(pattern=r"^[0-9a-fA-F]{64,200}$")
    voip_token: Optional[str] = Field(default=None, pattern=r"^[0-9a-fA-F]{64,200}$")
    environment: str = Field(pattern=r"^(sandbox|production)$")
    locale: str = Field(default="", max_length=35, pattern=r"^[A-Za-z0-9_-]*$")


class ActivityRegistration(BaseModel):
    activity_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    kind: str = Field(pattern=r"^chat_run$")
    push_token: str = Field(pattern=r"^[0-9a-fA-F]{32,512}$")


@router.post("/push/register", status_code=204)
async def push_register(body: PushRegistration, request: Request, user: str = Depends(require_user)) -> Response:
    """This phone's Apple push tokens. One registration per phone; sending again replaces it. The tokens stay on
    this computer until a notification is due, then go to the push relay in settings (and nowhere without one)."""
    device = _this_phone(request)
    try:
        mobile_activity.phone_register(user, device["id"], body.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return Response(status_code=204)


@router.delete("/push/register", status_code=204)
async def push_unregister(request: Request, user: str = Depends(require_user)) -> Response:
    mobile_activity.phone_unregister(_this_phone(request)["id"])
    return Response(status_code=204)


@router.post("/push/activity", status_code=204)
async def push_activity(body: ActivityRegistration, request: Request, user: str = Depends(require_user)) -> Response:
    """A Live Activity's own push token, so this desktop can update it while the app is closed. `activity_id` is
    the chat turn's id (the live stream's `turnId`), and it must be one of this account's own."""
    device = _this_phone(request)
    try:
        mobile_activity.phone_set_activity(user, device["id"], body.activity_id, body.kind, body.push_token)
    except LookupError:
        raise HTTPException(status_code=404, detail="That chat run is not one of yours.")
    return Response(status_code=204)


class RelayBody(BaseModel):
    url: str = Field(default="", max_length=phone_push.MAX_URL)


@router.get("/push/relay")
async def push_relay(user: str = Depends(require_admin)) -> dict:
    return {"url": phone_push.relay_url() or ""}


@router.put("/push/relay")
async def set_push_relay(body: RelayBody, request: Request, user: str = Depends(require_admin)) -> dict:
    """Where phone pushes are sent: the Kairos push relay's address, or nothing (then no push is sent)."""
    _from_this_app(request)
    try:
        url = phone_push.check_relay_url(body.url)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    settings_store.update_settings(**{phone_push.RELAY_SETTING: url or None})
    return {"url": url}
