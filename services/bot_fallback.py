"""Conservative turn recovery, shared by streamed and non-streamed chats.

No emitted event means no *evidence* of a started turn, not proof it did not
start. Recovery additionally requires a transport refusal or explicit
not_started evidence. Read timeouts and generic engine errors never replay.
"""
import contextlib

import httpx


class NotStarted(RuntimeError):
    def __init__(self, cause):
        super().__init__("The model could not start")
        self.cause = cause


def recoverable(error):
    raw = error.cause if isinstance(error, NotStarted) else error
    if isinstance(raw, (ConnectionRefusedError, httpx.ConnectError, httpx.ConnectTimeout)):
        return True
    status = getattr(getattr(raw, "response", None), "status_code", None)
    if status in (401, 403, 429):
        return True
    return (isinstance(error, NotStarted) or getattr(error, "not_started", False) is True) and (
        status is not None and 500 <= status <= 599 or getattr(raw, "recoverable", False) is True)


async def run(attempt, primary, fallback=(), *, allowed=lambda selection: True, on_switch=None):
    """attempt(selection) is an async event iterator; a started turn never retries.

    At most five distinct backups. Cancel and GeneratorExit propagate without
    recovery; a caller closing the stream closes its provider immediately.
    """
    seen, previous_error = set(), None
    for index, selection in enumerate([primary, *list(fallback)[:5]]):
        key = (selection.get("endpoint_id"), selection.get("model_override"))
        if key in seen or (index and not allowed(selection)):
            continue
        seen.add(key)
        started = False
        try:
            async with contextlib.aclosing(attempt(selection)) as stream:
                async for item in stream:
                    started = True
                    if index and on_switch:
                        on_switch(selection)
                        on_switch = None
                    yield item
            return
        except Exception as exc:
            if started or not recoverable(exc):
                raise
            previous_error = exc
    if previous_error:
        raise previous_error
    raise RuntimeError("No recovery model is available")
