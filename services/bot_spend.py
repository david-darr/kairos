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
    # A run whose cost is unknown makes the month's spend unknown (fourth review, 2026-11-11): with a cap set, that
    # fails closed for steps that can send, delete or run things (core/bot_policy.py), as Studio's hands-off does.
    unknown = cap is not None and bool(total["unknown_cost_runs"] or (total["cost_usd"] is None and total["runs"]))
    return {**config, "month": bot_usage.month(now), "spent_usd": spent, "spend_unknown": unknown,
            "unknown_cost_runs": total["unknown_cost_runs"], "capped": cap is not None and spent >= cap,
            "near_cap": cap is not None and spent >= cap * config["warn_percent"] / 100,
            "cost_note": "List-price equivalent, not billed"}


UNKNOWN_TEXT = ("This month's bot spend is not fully known (some runs have no price), and a spend cap is set, so steps "
                "that send, delete or run things wait until it is known. Reads and edits go on. " + CAP_TEXT)
_held: dict = {}   # account -> (when read, reason or "")
HOLD_CACHE_S = 30


def spend_hold(now=None):
    """Why a send, deletion or command must wait for spend to be known, or None (no cap set, or spend known)."""
    from core import accounts
    now = time.time() if now is None else now
    try:
        key = accounts.effective_account()
    except Exception:
        key = ""
    at, value = _held.get(key, (0.0, None))
    if now - at < HOLD_CACHE_S and value is not None:
        return value or None
    try:
        value = UNKNOWN_TEXT if budget(now).get("spend_unknown") else ""
    except Exception:
        value = ""   # the cap's own admission check still applies; no cap reading, no new hold
    _held[key] = (now, value)
    return value or None


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
