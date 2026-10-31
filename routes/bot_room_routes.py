"""Bots rooms: /api/bot-rooms. Thin over services/bot_rooms.py and services/bot_room_turns.py.

Every route needs a signed-in admin and the room must be that person's. A
missing or foreign id is a 404; a stale revision, a busy room or a pending
setup is a 409; unknown body fields are refused. Static routes (`/events`)
come before the `/{room_id}` routes so they are never read as an id.
"""
import asyncio
import contextlib

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from core import bot_rooms_store as store
from core.middleware import require_admin
from services import bot_room_events as feed, bot_room_goals, bot_room_turns as turns, bot_rooms as rooms

router = APIRouter(prefix="/api/bot-rooms", tags=["bot-rooms"])
KEEPALIVE_SECONDS = 15


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateBody(Body):
    name: str = Field(min_length=1, max_length=100)
    bot_ids: list[str] = Field(min_length=1, max_length=rooms.MAX_MEMBERS)
    context: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=120)
    bulletin: str = Field(default="", max_length=12000)
    cwd: str | None = Field(default=None, max_length=1024)
    default_responder: dict | None = None
    turn_timeout_minutes: int = Field(default=5, ge=1, le=1440)
    setup_done: bool = False


class PatchBody(Body):
    expected_revision: int | None = Field(default=None, ge=0)
    name: str | None = Field(default=None, max_length=100)
    context: str | None = Field(default=None, max_length=60)
    description: str | None = Field(default=None, max_length=120)
    bulletin: str | None = Field(default=None, max_length=12000)
    cwd: str | None = Field(default=None, max_length=1024)
    member_ids: list[str] | None = Field(default=None, max_length=rooms.MAX_MEMBERS)
    default_responder: dict | None = None
    turn_timeout_minutes: int | None = Field(default=None, ge=1, le=1440)
    pinned_message_id: str | None = Field(default=None, max_length=80)


class SetupBody(Body):
    action: str = Field(pattern="^(complete|skip)$")
    cwd: str | None = Field(default=None, max_length=1024)
    bulletin: str | None = Field(default=None, max_length=12000)
    default_responder: dict | None = None


class SendBody(Body):
    text: str = Field(min_length=1, max_length=100_000)
    send_id: str = Field(min_length=8, max_length=80)
    thread_id: str | None = Field(default=None, max_length=80)
    mode: str = Field(default="text", pattern="^(text|goal)$")
    reply_to_id: str | None = Field(default=None, max_length=80)


from routes.bot_widget_routes import Press  # noqa: E402  the same press body as a chat card


class HoldBody(Body):
    bot_id: str = Field(min_length=1, max_length=80)
    held: bool


class StopBody(Body):
    bot_id: str | None = Field(default=None, max_length=80)
    thread_id: str | None = Field(default=None, max_length=80)


class ThreadBody(Body):
    title: str = Field(default="", max_length=100)


class ThreadsDeleteBody(Body):
    thread_ids: list[str] = Field(min_length=1, max_length=rooms.BULK_DELETE_MAX)


class ReadBody(Body):
    seq: int | None = Field(default=None, ge=0)


@contextlib.contextmanager
def _guard():
    try:
        yield
    except store.Missing:
        raise HTTPException(404, "not found")
    except store.Stale as error:
        raise HTTPException(409, str(error))


def _fields(body: BaseModel) -> dict:
    return body.model_dump(exclude_unset=True)


# -- static routes first -------------------------------------------------------------

@router.get("")
async def list_rooms(include_archived: bool = False, user: str = Depends(require_admin)) -> dict:
    return {"rooms": rooms.list_rooms(user, include_archived)}


@router.post("")
async def create_room(body: CreateBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.create(user, body.name, bot_ids=body.bot_ids, context=body.context, description=body.description,
                            default_responder=body.default_responder, turn_timeout_minutes=body.turn_timeout_minutes,
                            cwd=body.cwd, bulletin=body.bulletin, setup_done=body.setup_done)


@router.get("/events")
async def events(request: Request, last_event_id: int | None = None, user: str = Depends(require_admin)):
    header = request.headers.get("last-event-id")
    last = last_event_id if last_event_id is not None else (int(header) if header and header.isdigit() else None)
    queue, hello = feed.subscribe(user, last)

    async def stream():
        try:
            yield feed.sse_hello(hello)
            while True:
                if await request.is_disconnected():
                    return
                try:
                    frame = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                    yield feed.sse(frame)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            feed.unsubscribe(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# -- one room ------------------------------------------------------------------------

@router.get("/{room_id}")
async def get_room(room_id: str, user: str = Depends(require_admin)) -> dict:
    return rooms.public(rooms.get(room_id, user))


@router.patch("/{room_id}")
async def patch_room(room_id: str, body: PatchBody, user: str = Depends(require_admin)) -> dict:
    fields = _fields(body)
    expected = fields.pop("expected_revision", None)
    with _guard():
        return rooms.update(user, room_id, fields, expected)


@router.delete("/{room_id}")
async def delete_room(room_id: str, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.delete(user, room_id)


@router.post("/{room_id}/setup")
async def setup_room(room_id: str, body: SetupBody, user: str = Depends(require_admin)) -> dict:
    fields = _fields(body)
    with _guard():
        return rooms.setup(user, room_id, body.action, cwd=fields.get("cwd", "__keep__"), bulletin=body.bulletin,
                           default_responder=body.default_responder)


@router.post("/{room_id}/read")
async def read_room(room_id: str, body: ReadBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.mark_read(user, room_id, body.seq)


# -- messages ------------------------------------------------------------------------

@router.get("/{room_id}/messages")
async def get_messages(room_id: str, thread_id: str | None = None, limit: int = 50, before: int | None = None,
                       around: str | None = None, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.messages(user, room_id, thread_id=thread_id, limit=limit, before=before, around=around)


@router.post("/{room_id}/messages", status_code=202)
async def send_message(room_id: str, body: SendBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return turns.submit(room_id, body.thread_id, body.text, body.send_id, body.mode, user, body.reply_to_id)


@router.post("/{room_id}/widgets/press")
async def press_card(room_id: str, body: "Press", user: str = Depends(require_admin)):
    """A card a bot showed in this room (services/bot_widgets.py press_room)."""
    from fastapi.responses import JSONResponse
    from services import bot_widgets
    try:
        with _guard():
            return await bot_widgets.press_room(user, room_id, body.model_dump())
    except bot_widgets.WidgetError as error:
        return JSONResponse({"detail": str(error)}, status_code=error.status)


@router.post("/{room_id}/holds")
async def set_hold(room_id: str, body: HoldBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return turns.hold(room_id, user, body.bot_id, body.held)


@router.post("/{room_id}/stop")
async def stop_room(room_id: str, body: StopBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return turns.stop(room_id, user, body.bot_id, body.thread_id)


@router.get("/{room_id}/queue")
async def get_queue(room_id: str, thread_id: str | None = None, user: str = Depends(require_admin)) -> dict:
    rooms.get(room_id, user)
    rows = store.queue_list(room_id, thread_id)
    return {"items": [{"id": r["id"], "state": r["state"], "thread_id": r["thread_id"], "text": r["payload"].get("text", ""),
                       "message_id": r["payload"].get("message_id"), "position": index + 1}
                      for index, r in enumerate(rows)]}


@router.delete("/{room_id}/queue/{queue_id}")
async def cancel_queue(room_id: str, queue_id: str, user: str = Depends(require_admin)) -> dict:
    rooms.get(room_id, user)
    row = store.queue_get(queue_id)
    if row is None or row["room_id"] != room_id:
        raise HTTPException(404, "queued message not found")
    if row["state"] != "pending":
        raise HTTPException(409, "That message already started")
    store.queue_mark([queue_id], "cancelled", only_from=("pending",))
    turns._queue_frame(room_id, row["thread_id"], user)
    return {"cancelled": True, "queue_id": queue_id}


# -- threads and goals ---------------------------------------------------------------

@router.get("/{room_id}/threads")
async def list_threads(room_id: str, user: str = Depends(require_admin)) -> dict:
    rooms.get(room_id, user)
    return {"threads": [{"id": t["id"], "title": t["title"], "goal": t["goal"], "created_at": t["created_at"],
                         "working": turns.thread_busy(room_id, t["id"])} for t in store.threads(room_id)]}


@router.post("/{room_id}/threads")
async def create_thread(room_id: str, body: ThreadBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.create_thread(user, room_id, body.title)


@router.post("/{room_id}/threads/delete")
async def delete_threads(room_id: str, body: ThreadsDeleteBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.delete_threads(user, room_id, body.thread_ids)


@router.patch("/{room_id}/threads/{thread_id}")
async def rename_thread(room_id: str, thread_id: str, body: ThreadBody, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.rename_thread(user, room_id, thread_id, body.title)


@router.delete("/{room_id}/threads/{thread_id}")
async def delete_thread(room_id: str, thread_id: str, user: str = Depends(require_admin)) -> dict:
    with _guard():
        return rooms.delete_threads(user, room_id, [thread_id])


@router.get("/{room_id}/threads/{thread_id}/goal")
async def get_goal(room_id: str, thread_id: str, user: str = Depends(require_admin)) -> dict:
    rooms.get(room_id, user)
    return {"goal": bot_room_goals.current(room_id, thread_id)}
