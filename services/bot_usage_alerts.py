"""One spend notification per threshold per UTC month, from authoritative owner."""
import logging

from services import bot_usage

log = logging.getLogger(__name__)


def notify(bot_id, value):
    try:
        from services.agent_service import agent_service
        from services.bot_attention import legacy_owner, owner_of, target_for
        from core.bot_attention_store import publish
        from core.events import emit
        bot = agent_service.get(bot_id)
        if not bot:
            return
        owner = owner_of(bot) or legacy_owner()
        if not owner:
            return
        with bot_usage.LOCK:
            flags = bot_usage.settings()["alerts"]
            for key, hit, line in (("warned", value["near_cap"], "Bot usage is near the monthly spend cap."),
                                   ("capped", value["capped"], "Bot usage reached the monthly spend cap.")):
                if not hit or flags.get(key) == value["month"]:
                    continue
                ident = f"spend:{value['month']}:{key}"
                publish(owner, ident, {"kind": "spend", "title": line, "body": "List-price equivalent, not billed",
                                       "agent_id": bot_id, "target": target_for(bot_id, owner)})
                emit("bot.spend", line, level="warn", agent_id=bot_id, threshold=key)
                flags[key] = value["month"]
            bot_usage.update_settings(alerts=flags)
    except Exception:
        log.exception("Could not publish spend alert")
