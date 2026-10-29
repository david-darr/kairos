"""Account usage limits as the routines engine sees them (Bots redesign, Phase 3
unit U2, 2026-10-29).

Spec: phase-3-design.md sections 2.3, 4.2 and 5.4.

`core/quota_usage.py` reads each subscription account's usage windows (the
5-hour and weekly ones). These are account limits, not quotas per model
connection, so every connection of one provider shares one reading. This
module turns those readings into what automations need:

- `windows()`: one normalized row per connected model with the account's
  windows, whether it is blocked (a window at 100%), near its limit (90%)
  and the time it frees up. Cached for 60 seconds; `refresh=True` asks again.
- `reset_time(endpoint_id)`: when the connection is usable again, as epoch
  seconds, or None when it is not blocked or no reset is known. A blocked
  connection frees up when every blocked window has reset.
- A `limit_reset` routine runs 60 seconds after that time.

Nothing here stores a credential or a provider response; only the numbers
quota_usage already normalized.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

CACHE_SECONDS = 60
NEAR_LIMIT = 90.0
BLOCKED = 100.0

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "rows": []}


def _overlay(force_provider: Optional[str] = None) -> dict:
    """The raw account readings. A seam for tests."""
    from core import quota_usage
    return quota_usage.get_usage_overlay(force_provider)


def _window_row(window: dict, now: float) -> dict:
    used = window.get("used_percent")
    resets = window.get("resets_at")
    blocked = isinstance(used, (int, float)) and used >= BLOCKED and (resets is None or resets > now)
    return {"name": window.get("name") or "", "used_percent": used, "resets_at": resets, "blocked": bool(blocked),
            "near_limit": isinstance(used, (int, float)) and used >= NEAR_LIMIT}


def normalize(overlay: dict, now: Optional[float] = None) -> list[dict]:
    """The overlay as one row per connected model that has an account window."""
    now = time.time() if now is None else now
    by_provider = {p.get("provider"): p for p in overlay.get("providers") or []}
    rows = []
    for model in overlay.get("models") or []:
        reading = by_provider.get(model.get("provider")) or model.get("quota") or {}
        windows = [_window_row(w, now) for w in reading.get("windows") or []]
        if not windows:
            continue
        blocked = [w for w in windows if w["blocked"]]
        pool = blocked or [w for w in windows if w["resets_at"] and w["resets_at"] > now]
        if blocked:
            resets_at = max((w["resets_at"] for w in blocked if w["resets_at"]), default=None)
        else:
            resets_at = min((w["resets_at"] for w in pool), default=None)
        rows.append({"endpoint_id": model["id"], "name": model.get("name") or "", "provider": model.get("provider"),
                     "status": reading.get("status") or "ok", "stale": bool(reading.get("stale")),
                     "windows": windows, "blocked": bool(blocked), "near_limit": any(w["near_limit"] for w in windows),
                     "resets_at": resets_at})
    return rows


def windows(refresh: bool = False, now: Optional[float] = None) -> list[dict]:
    """Normalized account windows, cached; `refresh` rereads the providers."""
    now = time.time() if now is None else now
    with _lock:
        if not refresh and _cache["rows"] and now - _cache["at"] < CACHE_SECONDS:
            return list(_cache["rows"])
    try:
        overlay = _overlay()
        if refresh:
            try:
                for provider in overlay.get("providers") or []:
                    overlay = _overlay(provider.get("provider"))
            except Exception:  # a forced read inside the throttle window keeps the cached one
                pass
        rows = normalize(overlay, now)
    except Exception:
        logger.exception("usage limits could not be read")
        with _lock:
            return list(_cache["rows"])
    with _lock:
        _cache.update(at=now, rows=rows)
    return list(rows)


def reset_time(endpoint_id: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """When this connection's account is usable again, or None."""
    if not endpoint_id:
        return None
    for row in windows(now=now):
        if row["endpoint_id"] == endpoint_id:
            return row["resets_at"] if row["blocked"] else _soonest(row)
    return None


def _soonest(row: dict) -> Optional[float]:
    """For a connection that is not blocked: the next reset of any window."""
    upcoming = [w["resets_at"] for w in row["windows"] if w["resets_at"]]
    return min(upcoming) if upcoming else None


def blocked_until(endpoint_id: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """The reset time only when the account is blocked right now."""
    now = time.time() if now is None else now
    for row in windows(now=now):
        if row["endpoint_id"] == endpoint_id and row["blocked"]:
            return row["resets_at"]
    return None


def clear_cache() -> None:
    with _lock:
        _cache.update(at=0.0, rows=[])
