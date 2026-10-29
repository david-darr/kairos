"""Bounded value ledger, with receipts so retried delivery counts once."""
import time
from services import front_desk_watch as store

MINUTES = {"sorted": 1, "drafted": 5, "prepped": 10, "routines": 3}


def record(kind, n=1, *, key=None, now=None):
    if kind not in MINUTES or not isinstance(n, int) or not 1 <= n <= 2000:
        raise ValueError("Invalid ledger entry")
    now = time.time() if now is None else now
    # Retention is measured from the real clock, not from the entry's time, so a
    # backdated entry never prunes newer ones; an entry already past retention is dropped.
    current = time.time()
    with store.LOCK:
        rows = [r for r in store.read("value", []) if current - 14 * 86400 <= r["at"] <= current + 300]
        if now >= current - 14 * 86400 and (not key or not any(r.get("key") == key for r in rows)):
            rows.append({"kind": kind, "n": n, "at": now, "key": key})
        store.write("value", rows[-2000:])


def totals(*, hours=16, now=None):
    now = time.time() if now is None else now
    rows = [r for r in store.read("value", []) if now - min(hours, 14 * 24) * 3600 <= r["at"] <= now]
    result = {kind: sum(r["n"] for r in rows if r["kind"] == kind) for kind in MINUTES}
    result["minutes"] = sum(result[k] * MINUTES[k] for k in MINUTES)
    return result


def line(*, now=None, recap=False):
    now = time.time() if now is None else now
    if not recap and now - store.read("presence").get("last_presence_at", 0) < 1800:
        return ""
    counts = totals(now=now, hours=14 * 24 if recap else 16)
    labels = {"sorted": "emails sorted", "drafted": "replies drafted", "prepped": "meetings prepped", "routines": "routines finished"}
    parts = [f"{counts[k]} {labels[k]}" for k in MINUTES if counts[k]]
    if not parts:
        return ""
    return ("So far: " if recap else "While you slept: ") + ", ".join(parts) + "."
