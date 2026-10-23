"""Saving autonomous Claude replies at the same session boundary as user turns."""
import asyncio
from dataclasses import replace
from contextlib import asynccontextmanager

_settling = set()


async def settle(session_id):
    from services import chat_service
    brain = chat_service._brains.get(session_id)
    if brain and hasattr(brain, 'settle_background'):
        _settling.add(session_id)
        try:
            await brain.settle_background()
        finally:
            _settling.discard(session_id)


def attach(session_id, brain, endpoint, is_admin):
    from core import runs
    from services import chat_service, chat_live

    @asynccontextmanager
    async def boundary():
        while chat_service.is_busy(session_id) and session_id not in _settling:
            await asyncio.sleep(.02)
        # A new user turn already owns the claim and is explicitly waiting
        # here before saving its user message. Borrow only that boundary.
        if session_id in _settling and chat_service.is_busy(session_id):
            yield
        else:
            async with chat_service.session_operation(session_id):
                yield

    async def followup(text, tally, result_meta):
        async with boundary():
            context = chat_service._run_context(session_id, endpoint, is_admin)
            if result_meta.get('started_at') is not None:
                context = replace(context, started_at=result_meta['started_at'])
            runs.record(context, tally, 'finished')
            chat_service._record_turn_telemetry(session_id, endpoint, brain, tally.usage)
            if text:
                manager = chat_service.session_manager
                index = manager.append_message(session_id, 'assistant', text,
                    extra={'background_followup': True, 'run_id': context.run_id})
                message = manager.get_session(session_id)['messages'][index]
                chat_live.broadcast_followup(session_id, message)
            chat_service._remember_claude_session(session_id, brain)

    brain.followup_handler = followup
