"""Monthly list-price-equivalent cap. Admission calls check before work starts."""
import time
from datetime import datetime, timezone

from services import bot_usage

CAP_TEXT = "An admin can raise it under Settings, Usage and spend."


class SpendCap(RuntimeError):
    status_code = 409
    code = "spend_cap"
    detail = CAP_TEXT

    def __init__(self):
        super().__init__(CAP_TEXT)


def budget(now=None):
    now = time.time() if now is None else now
    dt = datetime.fromtimestamp(now, timezone.utc)
    start = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    config = bot_usage.settings()["budget"]
    total = bot_usage.totals(bot_usage.rows(start, now + .001))
    spent = total["cost_usd"] or 0
    cap = config["monthly_usd"]
    return {**config, "month": bot_usage.month(now), "spent_usd": spent,
            "unknown_cost_runs": total["unknown_cost_runs"], "capped": cap is not None and spent >= cap,
            "near_cap": cap is not None and spent >= cap * config["warn_percent"] / 100,
            "cost_note": "List-price equivalent, not billed"}


def check(bot_id, now=None):
    if not bot_id:
        return
    bot_usage.drain()
    value = budget(now)
    from services.bot_usage_alerts import notify
    if value["near_cap"]:
        notify(bot_id, value)
    if value["capped"]:
        raise SpendCap()
    return value
