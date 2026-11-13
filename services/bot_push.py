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


def device_kind(notification_kind: str) -> str:
    """A retained feed row's kind -> the device push preference it falls under."""
    return "bot_needs_you" if notification_kind in ("question", "approval") else "bot_results"


def on_event(event: dict) -> None:
    """Every bus event reaches the attention feed once (a receipt makes a repeat
    a no-op); a bot with notifications turned off keeps its feed but sends no
    device alert. Each failure is its own: a subscriber never breaks the emitter."""
    agent_id = event.get("agent_id") or event.get("bot_id")
    kinds = set()
    legacy = kind_for(event)
    if legacy and agent_id:
        try:
            from services.agent_service import agent_service
            agent = agent_service.get(agent_id) or {}
            if agent.get("notifications") is not False:
                kinds.add(legacy)
        except Exception:
            logger.exception("bot push preference unreadable")
    try:
        from services import bot_attention
        kinds.update(device_kind(row["kind"]) for row in bot_attention.ingest_event(event))
    except Exception:
        logger.exception("bot attention feed not updated")
    try:
        from core import reach_me
        if reach_me.paused():
            kinds = set()       # STOP (Settings > Reach me): the feed is kept, no device alert
    except Exception:
        logger.exception("reach me pause unreadable")
    # A finished chat turn names its turn: its chat run sends the one notification for it (enqueue_bot skips).
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    turn_id = event.get("turn_id") or data.get("turn_id")
    for kind in kinds:
        try:
            mobile_activity.enqueue_bot(kind, agent_id, auth_manager.is_admin, turn_id=turn_id)
        except Exception:
            logger.exception("bot push not queued")


def start() -> None:
    global _started
    if not _started:
        events.subscribe(on_event)
        _started = True
