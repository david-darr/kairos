"""The rooms live feed (Phase 4, unit U2): frames in memory, replayed on reconnect.

Every change a room screen cares about is a frame: `room`, `room.deleted`,
`room.message`, `room.chunk`, `room.turn`, `room.queue`, `room.hold`. Each gets
a rising cursor. A reader that reconnects with the last cursor it saw gets
the frames it missed, in order, as long as they are still held (500 frames or
8,000,000 characters). A reader whose cursor is older than anything held, or
newer than the server knows (a restart), gets `reset: true` in its `hello`
and must load the room again from the message list instead of guessing.

Frames carry room data for the one signed-in person; the route filters by
owner. Never put secrets in a frame: callers pass redacted text only.
"""
import asyncio
import json
import threading
from collections import deque

MAX_FRAMES = 500
MAX_CHARS = 8_000_000

_LOCK = threading.RLock()
_FRAMES: deque = deque()
_CHARS = 0
_CURSOR = 0
_SUBSCRIBERS: list[tuple[asyncio.Queue, asyncio.AbstractEventLoop | None, str | None]] = []


def reset() -> None:
    """For tests: forget every frame and subscriber, and start the cursor over."""
    global _CHARS, _CURSOR
    with _LOCK:
        _FRAMES.clear()
        _SUBSCRIBERS.clear()
        _CHARS, _CURSOR = 0, 0


def cursor() -> int:
    return _CURSOR


def publish(kind: str, room_id: str | None, data: dict | None = None, owner: str | None = None) -> dict:
    """Add one frame and hand it to every live subscriber. Never raises."""
    global _CHARS, _CURSOR
    with _LOCK:
        _CURSOR += 1
        frame = {"id": _CURSOR, "type": kind, "room_id": room_id, "owner": owner, "data": data or {}}
        size = len(json.dumps(frame, default=str))
        _FRAMES.append((frame, size))
        _CHARS += size
        while len(_FRAMES) > MAX_FRAMES or (_CHARS > MAX_CHARS and len(_FRAMES) > 1):
            _, old = _FRAMES.popleft()
            _CHARS -= old
        targets = list(_SUBSCRIBERS)
    for queue, loop, who in targets:
        if who is not None and owner is not None and who != owner:
            continue
        _deliver(queue, loop, frame)
    return frame


def _deliver(queue: asyncio.Queue, loop, frame: dict) -> None:
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    try:
        if loop is not None and running is not loop:
            loop.call_soon_threadsafe(queue.put_nowait, frame)
        else:
            queue.put_nowait(frame)
    except Exception:
        pass  # a closed reader must never break the change that caused the frame


def subscribe(owner: str | None = None, last_id: int | None = None) -> tuple[asyncio.Queue, dict]:
    """(queue, hello). The queue first holds the frames missed since `last_id`.
    hello = {cursor, reset}: reset is true when those frames cannot be replayed."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    queue: asyncio.Queue = asyncio.Queue()
    with _LOCK:
        reset_needed = False
        if last_id is not None:
            oldest = _FRAMES[0][0]["id"] if _FRAMES else _CURSOR + 1
            if last_id > _CURSOR or last_id < oldest - 1:
                reset_needed = True
            else:
                for frame, _ in _FRAMES:
                    if frame["id"] > last_id and (owner is None or frame["owner"] in (None, owner)):
                        queue.put_nowait(frame)
        _SUBSCRIBERS.append((queue, loop, owner))
        hello = {"cursor": _CURSOR, "reset": reset_needed}
    return queue, hello


def unsubscribe(queue: asyncio.Queue) -> None:
    with _LOCK:
        _SUBSCRIBERS[:] = [s for s in _SUBSCRIBERS if s[0] is not queue]


def since(last_id: int, owner: str | None = None) -> list[dict] | None:
    """Frames after `last_id`, or None when they cannot be replayed."""
    with _LOCK:
        oldest = _FRAMES[0][0]["id"] if _FRAMES else _CURSOR + 1
        if last_id > _CURSOR or last_id < oldest - 1:
            return None
        return [f for f, _ in _FRAMES if f["id"] > last_id and (owner is None or f["owner"] in (None, owner))]


def sse(frame: dict) -> str:
    """One frame as a server-sent event. The cursor is the event id."""
    body = {"room_id": frame["room_id"], **frame["data"]}
    return f"id: {frame['id']}\nevent: {frame['type']}\ndata: {json.dumps(body, default=str)}\n\n"


def sse_hello(hello: dict) -> str:
    return f"event: hello\ndata: {json.dumps(hello)}\n\n"
