"""Authenticated, per-device Web Push enrollment. No public broadcast API."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from core import mobile_activity as store
from core.auth import SESSION_COOKIE_NAME
from core.middleware import require_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def same_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Cross-origin enrollment is not allowed")


class Enrollment(BaseModel):
    subscription: dict


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completed: bool = True
    failed: bool = True
    permission: bool = True


@router.get("")
def status(request: Request, user: str = Depends(require_user)):
    config = store.config(create=True)
    return {"public_key": config["public"], "devices": store.devices(user, store.binding(request.cookies.get(SESSION_COOKIE_NAME)))}


@router.post("/devices")
def enroll(body: Enrollment, request: Request, user: str = Depends(require_user)):
    same_origin(request)
    if request.url.scheme != "https":
        raise HTTPException(400, "Open Kairos through HTTPS Remote Access to enable notifications")
    try:
        store.config(create=True, subject=str(request.base_url).rstrip("/"))
        device_id = store.enroll(user, body.subscription, store.binding(request.cookies.get(SESSION_COOKIE_NAME)))
    except (ValueError, TypeError, KeyError) as error:
        raise HTTPException(422, str(error))
    return {"id": device_id}


@router.put("/devices/{device_id}")
def preferences(device_id: str, body: Preferences, request: Request, user: str = Depends(require_user)):
    same_origin(request)
    if not store.change_device(user, device_id, body.model_dump()):
        raise HTTPException(404, "device not found")
    return {"ok": True}


@router.delete("/devices/{device_id}")
def remove(device_id: str, request: Request, user: str = Depends(require_user)):
    same_origin(request)
    if not store.change_device(user, device_id):
        raise HTTPException(404, "device not found")
    return {"ok": True}


@router.post("/devices/{device_id}/test")
def test(device_id: str, request: Request, user: str = Depends(require_user)):
    same_origin(request)
    if not store.enqueue_test(user, device_id):
        raise HTTPException(404, "device not found")
    return {"ok": True}
