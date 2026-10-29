"""Bots Phase 3 U4: webhook addresses and connected-app event triggers (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6 and 9.

Included from routes/trigger_routes.py (its sole Phase 3 owner). This router has
complete absolute prefixes, so the parent router's `/api/triggers` prefix is never
applied to it (trigger_routes appends these routes; it does not nest the router).

Management endpoints need an admin and check that the record is the caller's: an id
that belongs to someone else, or does not exist, is a plain 404. Bodies forbid extra
fields and are bounded. The public ingress (`/api/bot-webhooks/in/...`) trusts
nothing: the credential is checked before the body is read, the body is read as a
bounded stream, and nothing an outsider sends reaches a model except fenced as data.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core import bot_app_events
from core import bot_event_receipts as receipts_module
from core.bot_app_event_adapters import ADAPTERS
from core.middleware import require_admin
from services import bot_app_triggers
from services.trigger_service import (ADDRESS_MAX_BODY, DEFAULT_MAX_PENDING, MAX_PENDING_RANGE, trigger_service)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bot-events"])


def automation_summaries(owner: str, is_admin: bool) -> list[dict]:
    """Adapt owned event sources to the unified Automations list."""
    rows = []
    for sub in bot_app_triggers.list_subscriptions(owner):
        shown = bot_app_triggers.public(sub)
        needs = bool(shown.get("last_error") or shown.get("poisoned"))
        rows.append({"id": sub["id"], "kind": "app", "bot_id": sub.get("agent_id"), "name": sub["name"],
                     "enabled": sub["enabled"], "state": "needs_you" if needs else "working" if sub["enabled"] else "paused",
                     "reason": shown.get("last_error") or "", "trigger": shown,
                     "fix": {"kind": "reconnect", "label": "Reconnect"} if needs else None})
    for trigger in trigger_service.triggers():
        if (trigger.get("owner_user") or owner) != owner or not trigger.get("agent_id"):
            continue
        rows.append({"id": trigger["id"], "kind": "webhook", "bot_id": trigger["agent_id"], "name": trigger["name"],
                     "enabled": trigger["enabled"], "state": "working" if trigger["enabled"] else "paused",
                     "trigger": _shown(trigger)})
    return rows


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConditionBody(_Strict):
    path: str = Field(min_length=1, max_length=200)
    equals: str = Field("", max_length=200)


class AppTriggerBody(_Strict):
    bot_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=80)
    events: list[str] = Field(min_length=1, max_length=20)
    conditions: list[ConditionBody] = Field(default_factory=list, max_length=10)
    config: dict = Field(default_factory=dict)
    title_template: str = Field("", max_length=200)
    prompt_template: str = Field(min_length=1, max_length=4000)
    auto_run: bool = False
    enabled: bool = True


class AppTriggerPatch(_Strict):
    expected_revision: Optional[str] = Field(None, max_length=20)
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    events: Optional[list[str]] = Field(None, min_length=1, max_length=20)
    conditions: Optional[list[ConditionBody]] = Field(None, max_length=10)
    config: Optional[dict] = None
    title_template: Optional[str] = Field(None, max_length=200)
    prompt_template: Optional[str] = Field(None, min_length=1, max_length=4000)
    auto_run: Optional[bool] = None
    enabled: Optional[bool] = None


class WebhookBody(_Strict):
    name: str = Field(min_length=1, max_length=80)
    agent_id: str = Field(min_length=1, max_length=64)
    events: list[str] = Field(default_factory=list, max_length=20)
    conditions: list[ConditionBody] = Field(default_factory=list, max_length=10)
    title_template: str = Field("", max_length=200)
    prompt_template: str = Field("", max_length=4000)
    auto_run: bool = False
    max_pending: int = Field(DEFAULT_MAX_PENDING, ge=MAX_PENDING_RANGE[0], le=MAX_PENDING_RANGE[1])


class WebhookPatch(_Strict):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    events: Optional[list[str]] = Field(None, max_length=20)
    conditions: Optional[list[ConditionBody]] = Field(None, max_length=10)
    title_template: Optional[str] = Field(None, max_length=200)
    prompt_template: Optional[str] = Field(None, max_length=4000)
    auto_run: Optional[bool] = None
    max_pending: Optional[int] = Field(None, ge=MAX_PENDING_RANGE[0], le=MAX_PENDING_RANGE[1])
    enabled: Optional[bool] = None


class WebhookTestBody(_Strict):
    payload: Optional[dict] = None
    event_type: str = Field("event", max_length=100)


def _dump(body, **extra) -> dict:
    fields = body.model_dump(exclude_unset=True)
    for key in ("conditions",):
        if fields.get(key) is not None:
            fields[key] = [c if isinstance(c, dict) else c.model_dump() for c in fields[key]]
    if len(str(fields.get("config") or {})) > 2000:
        raise HTTPException(status_code=422, detail="config is too large")
    return {**fields, **extra}


def _raise(error: bot_app_triggers.AppTriggerError):
    raise HTTPException(status_code=getattr(error, "status", 400), detail=str(error))


# -- connected-app event triggers -----------------------------------------------------------

@router.get("/api/bot-app-triggers/events")
async def app_capabilities(bot_id: Optional[str] = None, user: str = Depends(require_admin)) -> dict:
    """What this person's connected accounts really offer, and why anything is unavailable."""
    if bot_id:
        from services.agent_service import agent_service
        if agent_service.get(bot_id) is None:
            raise HTTPException(status_code=404, detail="bot not found")
    return {"capabilities": bot_app_events.capabilities(user)}


@router.get("/api/bot-app-triggers")
async def list_app_triggers(bot_id: Optional[str] = None, user: str = Depends(require_admin)) -> dict:
    return {"triggers": [bot_app_triggers.public(s) for s in bot_app_triggers.list_subscriptions(user, bot_id)],
            "deleted": bot_app_triggers.deleted(user)}


@router.post("/api/bot-app-triggers")
async def create_app_trigger(body: AppTriggerBody, user: str = Depends(require_admin)) -> dict:
    fields = _dump(body)
    bot_id = fields.pop("bot_id")
    try:
        return bot_app_triggers.public(bot_app_triggers.create(user, bot_id, fields))
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)


@router.patch("/api/bot-app-triggers/{trigger_id}")
async def update_app_trigger(trigger_id: str, body: AppTriggerPatch, user: str = Depends(require_admin)) -> dict:
    fields = _dump(body)
    expected = fields.pop("expected_revision", None)
    try:
        return bot_app_triggers.public(bot_app_triggers.update(user, trigger_id, fields, expected))
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)


@router.delete("/api/bot-app-triggers/{trigger_id}")
async def delete_app_trigger(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        sub = bot_app_triggers.delete(user, trigger_id)
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)
    return {"ok": True, "restorable_until": sub["deleted_at"] + bot_app_triggers.RESTORE_WINDOW}


@router.post("/api/bot-app-triggers/{trigger_id}/test")
async def test_app_trigger(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return await bot_app_triggers.test(user, trigger_id)
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)


@router.post("/api/bot-app-triggers/{trigger_id}/restore")
async def restore_app_trigger(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return bot_app_triggers.public(bot_app_triggers.restore(user, trigger_id))
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)


@router.post("/api/bot-app-triggers/{trigger_id}/sync")
async def sync_app_trigger(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return await bot_app_triggers.sync(user, trigger_id)
    except bot_app_triggers.AppTriggerError as error:
        _raise(error)


# -- webhooks ----------------------------------------------------------------------------------

def _mine(trigger_id: str, user: str) -> dict:
    """The caller's webhook. One made before ownership (no owner on it) belongs to any admin."""
    trigger = trigger_service.get(trigger_id)
    if trigger is None or (trigger.get("owner_user") or user) != user:
        raise HTTPException(status_code=404, detail="webhook not found")
    return trigger


def _shown(trigger: dict) -> dict:
    store = receipts_module.store()
    shown = trigger_service.public(trigger)
    shown.pop("log", None)  # the attempts endpoint is the redacted history
    shown["pending_runs"] = trigger_service.pending_for(trigger["id"])
    shown["has_sample"] = store.get_sample(trigger["id"]) is not None
    shown["attempt_count"] = store.attempt_count(trigger["id"])
    return shown


async def _read_capped(request: Request, cap: int) -> Optional[bytes]:
    """The body as a bounded stream: None as soon as it passes the cap, never buffering more than the cap."""
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        return None
    if declared > cap:
        return None
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > cap:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


async def _ingest(trigger_id: str, request: Request, path_credential: str = "") -> JSONResponse:
    trigger = trigger_service.get(trigger_id)
    if trigger is None or not trigger["enabled"] or trigger.get("ingress") != "address":
        return JSONResponse({"error": "not found"}, status_code=404)
    store = receipts_module.store()
    headers = dict(request.headers)
    owner = trigger.get("owner_user") or ""
    if not trigger_service.verify_address(trigger, headers, path_credential):
        # Recorded in the bounded attempts table only, so a stranger cannot make Kairos rewrite its trigger file.
        store.record_attempt("webhook", trigger_id, owner, "rejected", status_code=403, detail="missing or wrong credential")
        return JSONResponse({"error": "not allowed"}, status_code=403)
    import time as _time
    if not trigger_service.address_rate_ok(trigger_id, _time.time()):
        store.record_attempt("webhook", trigger_id, owner, "rate_limited", status_code=429,
                             detail="more than 10 events in a minute")
        return JSONResponse({"error": "too many events"}, status_code=429)
    body = await _read_capped(request, ADDRESS_MAX_BODY)
    if body is None:
        store.record_attempt("webhook", trigger_id, owner, "rejected", status_code=413, detail="body too large")
        return JSONResponse({"error": "too large"}, status_code=413)
    status, content, work = trigger_service.accept_address(trigger, headers, body)
    if work:
        try:
            await bot_app_events.hand_off(work["receipt_id"])  # a failure leaves the receipt durable and retried
        except Exception:
            logger.exception("webhook %s: hand-off failed; the receipt stays queued", trigger_id)
        waiting = any(p["trigger_id"] == trigger_id and p["delivery"] == work["delivery"] for p in trigger_service.pending())
        if not waiting:   # the run engine parks a delivery as a Backlog card until the person moves it to Ready
            from services.task_service import task_service
            ref = str((receipts_module.store().get(work["receipt_id"]) or {}).get("run_ref") or "")
            card = task_service.get_task(ref[5:]) if ref.startswith("card:") else None
            waiting = bool(card and card.get("status") == "backlog")
        if waiting:
            content = {**content, "waiting_for_approval": True}
    return JSONResponse(content, status_code=status)


# Registered first so a trigger id can never shadow the ingress path.
@router.post("/api/bot-webhooks/in/{trigger_id}/{credential}", include_in_schema=False)
async def ingress_with_path(trigger_id: str, credential: str, request: Request) -> JSONResponse:
    return await _ingest(trigger_id, request, credential)


@router.post("/api/bot-webhooks/in/{trigger_id}", include_in_schema=False)
async def ingress_with_header(trigger_id: str, request: Request) -> JSONResponse:
    return await _ingest(trigger_id, request)


@router.get("/api/bot-webhooks")
async def list_webhooks(bot_id: Optional[str] = None, user: str = Depends(require_admin)) -> dict:
    mine = [t for t in trigger_service.triggers() if (t.get("owner_user") or user) == user and t.get("agent_id")
            and (bot_id is None or t.get("agent_id") == bot_id)]
    return {"webhooks": [_shown(t) for t in mine], "deleted": trigger_service.deleted(user)}


@router.post("/api/bot-webhooks")
async def create_webhook(body: WebhookBody, user: str = Depends(require_admin)) -> dict:
    """A new address-mode webhook. It waits for the person's OK by default; Run straight away is their choice."""
    fields = _dump(body)
    name = fields.pop("name")
    try:
        trigger, _secret = trigger_service.create(name, ingress="address", owner_user=user, action="card", preset="generic",
                                                  **fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {**_shown(trigger), "address": trigger_service.address_of(trigger)}


@router.patch("/api/bot-webhooks/{trigger_id}")
async def update_webhook(trigger_id: str, body: WebhookPatch, user: str = Depends(require_admin)) -> dict:
    _mine(trigger_id, user)
    try:
        return _shown(trigger_service.update(trigger_id, **_dump(body)))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.delete("/api/bot-webhooks/{trigger_id}")
async def delete_webhook(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    _mine(trigger_id, user)
    trigger_service.delete(trigger_id)
    return {"ok": True, "restorable_days": 7}


@router.get("/api/bot-webhooks/{trigger_id}/address")
async def webhook_address(trigger_id: str, user: str = Depends(require_admin)) -> JSONResponse:
    trigger = _mine(trigger_id, user)
    if trigger.get("ingress") != "address":
        raise HTTPException(status_code=409, detail="this webhook uses signed requests, not an address")
    response = JSONResponse({"address": trigger_service.address_of(trigger),
                             "limits": {"body_bytes": ADDRESS_MAX_BODY, "per_minute": 10, "pending": trigger.get("max_pending")}})
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/api/bot-webhooks/{trigger_id}/attempts")
async def webhook_attempts(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    _mine(trigger_id, user)
    store = receipts_module.store()
    return {"attempts": store.attempts(trigger_id), "total": store.attempt_count(trigger_id)}


@router.post("/api/bot-webhooks/{trigger_id}/capture")
async def webhook_capture(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    """Wait for the next authenticated request, keep it as the one sample and start nothing."""
    trigger = _mine(trigger_id, user)
    if trigger.get("ingress") != "address":
        raise HTTPException(status_code=409, detail="capture is for address webhooks")
    receipts_module.store().clear_sample(trigger_id)
    trigger_service.arm_capture(trigger_id)
    return {"capturing": True}


@router.get("/api/bot-webhooks/{trigger_id}/sample")
async def webhook_sample(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    trigger = _mine(trigger_id, user)
    return {"capturing": bool(trigger.get("capture")), "sample": trigger_service.sample(trigger_id)}


@router.post("/api/bot-webhooks/{trigger_id}/test")
async def webhook_test(trigger_id: str, body: WebhookTestBody, user: str = Depends(require_admin)) -> dict:
    """A manual test with the sample (or a payload you give): what would happen, nothing started."""
    import json
    trigger = _mine(trigger_id, user)
    payload = body.payload
    if payload is None:
        sample = trigger_service.sample(trigger_id)
        if sample is None:
            raise HTTPException(status_code=409, detail="capture a sample first, or send a payload to test with")
        try:
            payload = json.loads(sample["body"]) if sample["kind"] == "json" else {"raw": sample["body"]}
        except ValueError:
            payload = {"raw": sample["body"]}
    result = trigger_service.dry_run(trigger, payload, body.event_type)
    receipts_module.store().record_attempt("webhook", trigger_id, user, "test", event_type=body.event_type,
                                           detail="manual test; nothing started")
    return result


@router.post("/api/bot-webhooks/{trigger_id}/rotate")
async def webhook_rotate(trigger_id: str, user: str = Depends(require_admin)) -> JSONResponse:
    """An explicit replacement: the old address stops working at once."""
    trigger = _mine(trigger_id, user)
    trigger_service.new_secret(trigger_id)
    receipts_module.store().record_attempt("webhook", trigger_id, user, "rotated", detail="credential replaced")
    response = JSONResponse({"address": trigger_service.address_of(trigger_service.get(trigger_id))
                             if trigger.get("ingress") == "address" else None, "rotated": True})
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/api/bot-webhooks/{trigger_id}/restore")
async def webhook_restore(trigger_id: str, user: str = Depends(require_admin)) -> dict:
    try:
        return _shown(trigger_service.restore(user, trigger_id))
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error).strip("'\""))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
