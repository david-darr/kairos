"""Minute lifecycle tick. It never performs a model turn."""
import asyncio
import logging

logger = logging.getLogger(__name__)
_task = None


async def tick():
    from services import front_desk_watch as watch, front_desk_brief as brief
    # Independent jobs: a connector/install failure must not suppress recap.
    for method in (watch.ensure_watch, brief.morning_due, brief.recap_due):
        try:
            if asyncio.iscoroutinefunction(method):
                await method()
            else:
                await asyncio.to_thread(method)
        except Exception:
            logger.exception("Front-desk tick job failed: %s", getattr(method, "__name__", repr(method)))


async def _loop():
    while True:
        await tick()
        await asyncio.sleep(60)


def start():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="front-desk-tick")
    return _task


async def stop():
    global _task
    task, _task = _task, None
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
