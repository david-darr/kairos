"""Phone push for bots (Agents 2.0, 2026-10-14). Listens to the event bus for
a bot needing the person (a question) or having results (a report, or a card
waiting for review) and queues a push through the existing outbox, which
coalesces them and delivers only to admins' devices. The desktop half lives in
static/js/botNotifications.js and reads the same inbox the app already polls."""
import logging

from core import events, mobile_activity
from core.auth import auth_manager

logger = logging.getLogger(__name__)
_started = False


def kind_for(event: dict) -> str | None:
    if event.get("type") == "agent.inbox":
        return "bot_needs_you" if event.get("item_kind") == "question" else "bot_results"
    if event.get("type") == "agent.review":
        return "bot_results"
    return None


def on_event(event: dict) -> None:
    kind = kind_for(event)
    agent_id = event.get("agent_id")
    if not kind or not agent_id:
        return
    try:
        mobile_activity.enqueue_bot(kind, agent_id, auth_manager.is_admin)
    except Exception:  # an event subscriber must never break the emitter
        logger.exception("bot push not queued")


def start() -> None:
    global _started
    if not _started:
        events.subscribe(on_event)
        _started = True
