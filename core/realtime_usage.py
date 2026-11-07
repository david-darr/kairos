"""Realtime voice minutes, per account (build spec 6b): which provider, how many seconds, the estimated cost.

One small JSON file in each account's own folder (`realtime_usage.json`, new, so no layout migration is involved), counted by calendar month. No audio and no words are kept.
The price is an estimate from core/realtime_voice.py, shown as such; the provider's own bill is the truth.
"""
import os
import time

from core.atomic_io import read_json, write_json_atomic

USAGE_FILE = None        # a test can point it at its own file; otherwise the current account's
KEEP_MONTHS = 24


def usage_file() -> str:
    from core import accounts
    return USAGE_FILE or os.path.join(accounts.account_dir(), "realtime_usage.json")


def _month(at=None) -> str:
    return time.strftime("%Y-%m", time.localtime(at or time.time()))


def record(provider: str, seconds: float, calls: int = 1, at=None) -> dict:
    """Add one finished session (or a slice of a long one) to this account's month. Returns that month's row."""
    from core import realtime_voice
    seconds = max(0.0, min(float(seconds or 0), 6 * 3600))
    data = read_json(usage_file(), {})
    month = data.setdefault(_month(at), {})
    row = month.setdefault(provider, {"seconds": 0.0, "calls": 0, "cost_estimate": 0.0})
    row["seconds"] = round(row["seconds"] + seconds, 2)
    row["calls"] += calls
    row["cost_estimate"] = round(row["cost_estimate"] + realtime_voice.cost_estimate(provider, seconds), 4)
    for old in sorted(data)[:-KEEP_MONTHS]:
        data.pop(old, None)
    write_json_atomic(usage_file(), data)
    return row


def summary(month: str = "") -> dict:
    """{'month', 'providers': {name: {seconds, minutes, calls, cost_estimate}}, 'minutes', 'cost_estimate'}"""
    month = month or _month()
    providers = {}
    for name, row in (read_json(usage_file(), {}).get(month) or {}).items():
        providers[name] = {**row, "minutes": round(row.get("seconds", 0) / 60, 2)}
    return {"month": month, "providers": providers,
            "minutes": round(sum(p["minutes"] for p in providers.values()), 2),
            "cost_estimate": round(sum(p.get("cost_estimate", 0) for p in providers.values()), 4)}
