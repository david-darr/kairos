"""Bots conversations: /api/bot-chat. Thin over services/bot_chat_service.py.

Every route needs a signed-in user and checks that the conversation is that
person's and belongs to a bot. Unknown or foreign targets are a 404; a stale
view, a busy edit or a reused send ID is a 409. Stopping a turn that is
already over is a successful no-op.
"""
import contextlib

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from core import bot_chat_store, bot_message_tree
from core.middleware import require_user
from services import bot_chat_service as service, bot_goal_runs

router = APIRouter(prefix="/api/bot-chat", tags=["bot-chat"])


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SendBody(Body):
    send_id: str = Field(min_length=8, max_length=80)
    text: str = Field(max_length=100_000)
    expected_leaf_id: str | None = Field(default=None, max_length=80)
    attachment_ids: list[str] = Field(default_factory=list, max_length=10)
    reply_to_id: str | None = Field(default=None, max_length=80)
    citations: list[dict] = Field(default_factory=list, max_length=20)
    references: list[dict] = Field(default_factory=list, max_length=5)
    mode: str | None = Field(default=None, max_length=20)
    # Phase 6: the data result the person has open ({cardId, draftSql}) and up to five app parts they pointed at.
    data_context: dict | None = None
    pointed: list[dict] = Field(default_factory=list, max_length=5)


class EditBody(Body):
    send_id: str = Field(min_length=8, max_length=80)
    text: str = Field(max_length=100_000)
    expected_leaf_id: str | None = Field(default=None, max_length=80)
    expected_revision: int = Field(ge=0)
    attachment_ids: list[str] | None = Field(default=None, max_length=10)
    references: list[dict] = Field(default_factory=list, max_length=5)
    citations: list[dict] = Field(default_factory=list, max_length=20)
    reply_to_id: str | None = Field(default=None, max_length=80)


class RegenerateBody(Body):
    send_id: str = Field(min_length=8, max_length=80)
    expected_leaf_id: str | None = Field(default=None, max_length=80)
    expected_revision: int = Field(ge=0)


class BranchBody(Body):
    message_id: str = Field(min_length=1, max_length=80)
    expected_revision: int = Field(ge=0)


class SteerBody(Body):
    turn_id: str | None = Field(default=None, max_length=80)
    queue_revision: int = Field(ge=0)
    group_ids: list[str] | None = Field(default=None, max_length=30)


class InterruptBody(Body):
    turn_id: str = Field(min_length=1, max_length=80)


class ReactionBody(Body):
    emoji: str = Field(max_length=20)
    on: bool


class PinBody(Body):
    message_id: str | None = Field(max_length=80)


class ReadBody(Body):
    message_id: str | None = Field(default=None, max_length=80)


class GoalStopBody(Body):
    root_id: str = Field(min_length=1, max_length=80)


class PresenceBody(Body):
    timezone: str | None = Field(default=None, max_length=100)
    language: str | None = Field(default=None, max_length=35)
    focused_thread: str | None = Field(default=None, max_length=80)


@contextlib.contextmanager
def _guard():
    """The service's plain errors as HTTP answers."""
    try:
        yield
    except (bot_chat_store.Conflict, bot_message_tree.Stale) as error:
        raise HTTPException(409, str(error))
    except KeyError:
        raise HTTPException(404, "not found")
    except ValueError as error:
        raise HTTPException(422, str(error))


# These two come before the /{session_id} routes so they are never read as an ID.

@router.get("/search")
async def search(q: str, bot_id: str | None = None, session_id: str | None = None, limit: int = 40,
                 user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.search(user, q, bot_id, session_id, limit)


@router.post("/presence")
async def presence(body: PresenceBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.presence(user, body.model_dump())


@router.get("/{session_id}/state")
async def get_state(session_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.state(user, session_id)


@router.get("/{session_id}/messages")
async def get_messages(session_id: str, limit: int = 50, before: str | None = None, around: str | None = None,
                       after: str | None = None, user: str = Depends(require_user)) -> dict:
    if sum(value is not None for value in (before, around, after)) > 1:
        raise HTTPException(422, "Use one of before, around or after")
    with _guard():
        return service.messages(user, session_id, limit, before, around, after)


@router.post("/{session_id}/send", status_code=202)
async def send(session_id: str, body: SendBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.send(user, session_id, body.model_dump())


@router.get("/{session_id}/queue")
async def get_queue(session_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.queue_view(user, session_id)


@router.post("/{session_id}/queue/resume")
async def resume_queue(session_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.queue_resume(user, session_id)


@router.delete("/{session_id}/queue/{queue_id}")
async def delete_queued(session_id: str, queue_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.queue_cancel(user, session_id, queue_id)


@router.post("/{session_id}/queue/{queue_id}/edit")
async def edit_queued(session_id: str, queue_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.queue_edit(user, session_id, queue_id)


@router.post("/{session_id}/queue/{queue_id}/steer")
async def steer_queued(session_id: str, queue_id: str, body: SteerBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.queue_steer(user, session_id, queue_id, body.model_dump())


@router.post("/{session_id}/interrupt")
async def interrupt(session_id: str, body: InterruptBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.interrupt(user, session_id, body.turn_id)


@router.post("/{session_id}/goal/stop")
async def stop_goal(session_id: str, body: GoalStopBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        service.require(user, session_id)
        return bot_goal_runs.stop(user, session_id, body.root_id)


@router.post("/{session_id}/messages/{message_id}/edit", status_code=202)
async def edit_message(session_id: str, message_id: str, body: EditBody, user: str = Depends(require_user)) -> dict:
    data = body.model_dump(exclude_unset=True)
    with _guard():
        return await service.edit_message(user, session_id, message_id, data)


@router.post("/{session_id}/regenerate", status_code=202)
async def regenerate(session_id: str, body: RegenerateBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.regenerate(user, session_id, body.model_dump())


@router.post("/{session_id}/active-branch")
async def active_branch(session_id: str, body: BranchBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.select_branch(user, session_id, body.model_dump())


@router.post("/{session_id}/messages/{message_id}/reaction")
async def reaction(session_id: str, message_id: str, body: ReactionBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.react(user, session_id, message_id, body.emoji, body.on)


@router.patch("/{session_id}/pin")
async def pin(session_id: str, body: PinBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.pin(user, session_id, body.message_id)


@router.post("/{session_id}/read")
async def read(session_id: str, body: ReadBody, user: str = Depends(require_user)) -> dict:
    with _guard():
        return service.mark_read(user, session_id, body.message_id)


@router.post("/{session_id}/compact")
async def compact(session_id: str, user: str = Depends(require_user)) -> dict:
    with _guard():
        return await service.compact(user, session_id)


@router.get("/{session_id}/export")
async def export(session_id: str, format: str = "markdown", user: str = Depends(require_user)) -> dict:
    if format not in ("markdown", "json"):
        raise HTTPException(422, "format is markdown or json")
    with _guard():
        return service.export(user, session_id, format)
