"""Routine endpoints (Bots redesign, Phase 3 unit U2, 2026-10-29).

Spec: phase-3-design.md section 6. Every path here is complete and absolute
(`/api/bot-routines...`); routes/task_routes.py adds this router's routes to its
own so `app.py` mounts them, and nothing is nested under `/api/tasks`.

All of it needs an admin and checks ownership of every routine and run it
touches: someone else's id answers 404, never "forbidden". Bodies forbid
unknown fields and are bounded.
"""
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from core.auth import auth_manager
from core.middleware import require_admin
from services import bot_limit_resets, bot_routines
from services.bot_routines import RoutineError
from services.task_service import task_service

router = APIRouter(tags=["bot-routines"])

# Other engines add their rows to the unified Automations list (webhooks and
# app events, unit U4): fn(owner, is_admin) -> list of summaries.
_summary_sources: list[Callable] = []


def register_summary_source(fn: Callable) -> None:
    if fn not in _summary_sources:
        _summary_sources.append(fn)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RoutineBody(Strict):
    bot_id: str = Field(min_length=1, max_length=80)
    name: str = Field(max_length=200)
    instructions: str = Field(max_length=20000)
    schedule: dict
    enabled: Optional[bool] = None
    report: Optional[str] = None
    overlap: Optional[str] = None
    access: Optional[str] = None
    deliver: Optional[str] = None
    duration_minutes: Optional[int] = None
    timeout_minutes: Optional[int] = None
    continuity: Optional[bool] = None
    call: Optional[bool] = None
    run_on_startup: Optional[bool] = None
    attachments: Optional[list[str]] = Field(default=None, max_length=50)
    checks: Optional[list[str]] = Field(default=None, max_length=3)
    source_thread_id: Optional[str] = Field(default=None, max_length=80)
    results_thread_id: Optional[str] = Field(default=None, max_length=80)


class PatchBody(Strict):
    expected_revision: Optional[str] = Field(default=None, max_length=40)
    name: Optional[str] = Field(default=None, max_length=200)
    instructions: Optional[str] = Field(default=None, max_length=20000)
    schedule: Optional[dict] = None
    enabled: Optional[bool] = None
    report: Optional[str] = None
    overlap: Optional[str] = None
    access: Optional[str] = None
    deliver: Optional[str] = None
    duration_minutes: Optional[int] = None
    timeout_minutes: Optional[int] = None
    continuity: Optional[bool] = None
    call: Optional[bool] = None
    run_on_startup: Optional[bool] = None
    attachments: Optional[list[str]] = Field(default=None, max_length=50)
    checks: Optional[list[str]] = Field(default=None, max_length=3)
    source_thread_id: Optional[str] = Field(default=None, max_length=80)
    results_thread_id: Optional[str] = Field(default=None, max_length=80)


class DeleteBody(Strict):
    expected_revision: Optional[str] = Field(default=None, max_length=40)


class RunBody(Strict):
    request_id: Optional[str] = Field(default=None, max_length=80)


class PreviewBody(Strict):
    schedule: dict
    count: int = Field(default=3, ge=1, le=20)


class DeferBody(Strict):
    until: str = Field(max_length=80)
    expected_revision: str = Field(max_length=40)


class AfterResetBody(Strict):
    routine_id: str = Field(min_length=1, max_length=80)


class ContinueBody(Strict):
    bot_id: str = Field(min_length=1, max_length=80)
    thread_id: str = Field(min_length=1, max_length=80)


def _fail(error: RoutineError) -> JSONResponse:
    return JSONResponse(status_code=error.status, content={"detail": str(error), "code": error.code, "field": error.field})


def _is_admin(user: str) -> bool:
    return auth_manager.is_admin(user)


def _fields(body: BaseModel) -> dict:
    return {k: v for k, v in body.model_dump(exclude_unset=True).items() if k not in ("bot_id", "expected_revision")}


# -- routines --------------------------------------------------------------------------------

@router.get("/api/bot-routines")
async def list_routines(bot_id: Optional[str] = Query(default=None, max_length=80),
                        start: Optional[float] = None, end: Optional[float] = None, user: str = Depends(require_admin)):
    if (start is None) != (end is None) or (start is not None and (end < start or end - start > 70 * 86400)):
        return _fail(RoutineError("Give a start and an end, at most 70 days apart."))
    return {"routines": bot_routines.list_routines(user, _is_admin(user), bot_id, start, end)}


@router.post("/api/bot-routines/preview")
async def preview(body: PreviewBody, user: str = Depends(require_admin)):
    try:
        return bot_routines.preview(body.schedule, body.count)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-routines")
async def create_routine(body: RoutineBody, user: str = Depends(require_admin)):
    try:
        return bot_routines.create_for_owner(user, body.bot_id, _fields(body))
    except RoutineError as error:
        return _fail(error)


@router.get("/api/bot-routines/{routine_id}")
async def get_routine(routine_id: str, user: str = Depends(require_admin)):
    try:
        return bot_routines.get_routine(user, _is_admin(user), routine_id)
    except RoutineError as error:
        return _fail(error)


@router.get("/api/bot-routines/{routine_id}/runs")
async def routine_runs(routine_id: str, limit: int = Query(default=30, ge=1, le=50), user: str = Depends(require_admin)):
    try:
        return {"runs": bot_routines.list_runs(user, _is_admin(user), routine_id, limit)}
    except RoutineError as error:
        return _fail(error)


@router.patch("/api/bot-routines/{routine_id}")
async def patch_routine(routine_id: str, body: PatchBody, user: str = Depends(require_admin)):
    try:
        return bot_routines.patch(user, _is_admin(user), routine_id, _fields(body), body.expected_revision)
    except RoutineError as error:
        return _fail(error)


@router.delete("/api/bot-routines/{routine_id}")
async def delete_routine(routine_id: str, body: Optional[DeleteBody] = None, user: str = Depends(require_admin)):
    try:
        return bot_routines.delete(user, _is_admin(user), routine_id, body.expected_revision if body else None)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-routines/{routine_id}/restore")
async def restore_routine(routine_id: str, user: str = Depends(require_admin)):
    try:
        return bot_routines.restore_deleted(user, _is_admin(user), routine_id)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-routines/{routine_id}/run")
async def run_routine(routine_id: str, body: Optional[RunBody] = None, user: str = Depends(require_admin)):
    try:
        return await bot_routines.run_now(user, _is_admin(user), routine_id, body.request_id if body else None)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-routines/{routine_id}/defer")
async def defer_routine(routine_id: str, body: Optional[DeferBody] = None, user: str = Depends(require_admin)):
    try:
        if body is not None:
            from datetime import datetime
            import time
            try:
                date = datetime.fromisoformat(body.until.replace("Z", "+00:00"))
                if date.tzinfo is None or date.timestamp() <= time.time():
                    raise ValueError()
            except ValueError:
                raise RoutineError("Choose a future time with a timezone.", field="until")
            return bot_routines.move_next_run(user, _is_admin(user), routine_id, date.timestamp(), body.expected_revision)
        return bot_routines.defer(user, _is_admin(user), routine_id)
    except RoutineError as error:
        return _fail(error)


# -- runs --------------------------------------------------------------------------------------

@router.post("/api/bot-routine-runs/seen-all")
async def seen_all(bot_id: Optional[str] = Query(default=None, max_length=80), user: str = Depends(require_admin)):
    return bot_routines.seen_all(user, _is_admin(user), bot_id)


@router.post("/api/bot-routine-runs/{run_id}/cancel")
async def cancel_run(run_id: str, user: str = Depends(require_admin)):
    try:
        return bot_routines.cancel_run(user, _is_admin(user), run_id)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-routine-runs/{run_id}/seen")
async def seen_run(run_id: str, user: str = Depends(require_admin)):
    try:
        return bot_routines.mark_seen(user, _is_admin(user), run_id)
    except RoutineError as error:
        return _fail(error)


# -- the unified list --------------------------------------------------------------------------

@router.get("/api/bot-automations")
async def automations(user: str = Depends(require_admin)):
    rows: list[dict] = list(bot_routines.routine_summaries(user, _is_admin(user)))
    for source in list(_summary_sources):
        try:
            rows.extend(source(user, _is_admin(user)) or [])
        except Exception:
            continue  # one source failing must not hide the others
    order = {"needs_you": 0, "working": 1, "paused": 2, "done": 3}
    rows.sort(key=lambda r: (order.get(r.get("state"), 4), r.get("next_run_at") or "9", r.get("name") or ""))
    return {"automations": rows}


# -- usage limits ----------------------------------------------------------------------------------

@router.get("/api/bot-limit-resets")
async def limit_resets(refresh: bool = False, user: str = Depends(require_admin)):
    import asyncio
    return {"limits": await asyncio.to_thread(bot_limit_resets.windows, refresh)}


@router.post("/api/bot-limit-resets/after-reset")
async def after_reset(body: AfterResetBody, user: str = Depends(require_admin)):
    """Move only this routine's next run to just after its account's limit resets."""
    from core import task_scheduler
    task = task_service.get_task(body.routine_id)
    if not bot_routines.is_routine(task) or not bot_routines.owned_by(task, user, _is_admin(user)):
        return _fail(RoutineError("routine not found", 404, "not_found"))
    endpoint = task_scheduler.task_endpoint_id(task)
    reset = bot_limit_resets.reset_time(endpoint) if endpoint else None
    if reset is None:
        return _fail(RoutineError("No reset time is known for this bot's account right now.", 409, "no_reset"))
    try:
        return bot_routines.move_next_run(user, _is_admin(user), body.routine_id, reset + 60)
    except RoutineError as error:
        return _fail(error)


@router.post("/api/bot-limit-resets/continue")
async def continue_when_reset(body: ContinueBody, user: str = Depends(require_admin)):
    """One once-only routine in this conversation that runs after the limit resets."""
    from core.session_manager import session_manager
    from services.agent_service import agent_service
    agent = agent_service.get(body.bot_id)
    session = session_manager.get_session(body.thread_id)
    if agent is None or session is None or session.get("agent_id") != body.bot_id:
        return _fail(RoutineError("That conversation was not found for this bot.", 404, "not_found"))
    endpoint = agent_service.chat_endpoint(agent)
    if not endpoint or bot_limit_resets.reset_time(endpoint) is None:
        return _fail(RoutineError("No reset time is known for this bot's account right now.", 409, "no_reset"))
    try:
        return bot_routines.continue_after_reset(user, body.bot_id, body.thread_id, endpoint, session.get("title") or "")
    except RoutineError as error:
        return _fail(error)
