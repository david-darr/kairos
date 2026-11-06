"""Work projection and bounded task/suggestion actions."""
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from core.bot_chat_store import Conflict
from core.middleware import require_user
from services import front_desk_tasks as tasks, front_desk_work as work, front_desk_suggestions as suggestions

router = APIRouter(prefix="/api/front-desk", tags=["front-desk-work"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskBody(Body):
    text: str = Field(min_length=1, max_length=4000)
    kind: Literal["task", "make"] = "task"
    make_kind: Literal["design", "slides", "website", "files"] | None = None
    save_for_later: bool = False
    send_id: str = Field(min_length=8, max_length=80)
    channel_tag: str | None = Field(default=None, max_length=80)


class AgainBody(Body):
    turn_count: int = Field(ge=0, le=1000000)


@contextmanager
def guard():
    try:
        yield
    except KeyError:
        raise HTTPException(404, "Task or suggestion not found")
    except Conflict as error:
        raise HTTPException(409, str(error))
    except ValueError as error:
        raise HTTPException(422, str(error))


@router.get("/work")
async def get_work(resolved: int = Query(default=0, ge=0, le=1), user: str = Depends(require_user)):
    with guard():
        return work.work(user=user, resolved=bool(resolved))


@router.get("/suggestions")
async def get_suggestions(user: str = Depends(require_user)):
    with guard():
        return {"suggestions": suggestions.list_suggestions(user)}


@router.post("/tasks")
async def start_task(body: TaskBody, user: str = Depends(require_user)):
    with guard():
        tasks.require_owner(user)
        if not body.text.strip():
            raise ValueError("Write a task first")
        if body.kind == "make" and body.make_kind is None:
            raise ValueError("Choose what to make")
        if body.save_for_later:
            return {"suggestion": suggestions.add(tasks.title_from(body.text), body.text[:400], None, "asked",
                                                   ask=body.text.strip(), make_kind=body.make_kind,
                                                   channel_tag=body.channel_tag, send_id=body.send_id)}
        return work.project(tasks.start(body.text, origin="make" if body.kind == "make" else "asked",
                                       kind=body.kind, make_kind=body.make_kind, channel_tag=body.channel_tag,
                                       send_id=body.send_id))


@router.get("/tasks/{task_id}/report")
async def task_report(task_id: str, user: str = Depends(require_user)):
    with guard():
        return work.report(task_id, user=user)


@router.get("/tasks/{task_id}")
async def get_task(task_id: str, user: str = Depends(require_user)):
    with guard():
        return work.project(tasks.get(task_id, user))


@router.post("/tasks/{task_id}/resolve")
async def resolve_task(task_id: str, body: Body, user: str = Depends(require_user)):
    with guard():
        return tasks.resolve(task_id, user=user)


@router.post("/tasks/{task_id}/reopen")
async def reopen_task(task_id: str, body: Body, user: str = Depends(require_user)):
    with guard():
        return tasks.resolve(task_id, user=user, reopen=True)


@router.post("/tasks/{task_id}/again")
async def again_task(task_id: str, body: AgainBody, user: str = Depends(require_user)):
    with guard():
        return tasks.again(task_id, user=user, expected_turn_count=body.turn_count)


@router.post("/suggestions/{suggestion_id}/start")
async def start_suggestion(suggestion_id: str, body: Body, user: str = Depends(require_user)):
    with guard():
        return work.project(suggestions.start(suggestion_id, user=user))


@router.post("/suggestions/{suggestion_id}/hide")
async def hide_suggestion(suggestion_id: str, body: Body, user: str = Depends(require_user)):
    with guard():
        return suggestions.hide(suggestion_id, user=user)
