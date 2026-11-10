"""Event bus — the cross-domain trigger backbone (David's ask 2026-09-02,
from the vault's Harness Architecture Ideas note: Odysseus's event system,
idea #5 — one reusable "when X happens" mechanism instead of each feature
hand-rolling its own).

Two halves, deliberately minimal:
- emit(): synchronous, never raises to the caller (an event is telemetry, a
  failed emit must not break the operation that fired it). Appends to a
  persisted ring buffer (data/events.json) and notifies any in-process
  subscribers.
- subscribe(): in-process listeners for future automation (alerting,
  chaining, proactive nudges). Nothing subscribes yet — today's consumer is
  the Home activity feed reading recent() via /api/system/events.

Event shape: {"ts": epoch, "type": str, "message": str, "level": "info" |
"warn" | "error", **extra}. `type` is a stable machine key (e.g.
"task.run", "task.delivery_failed", "channel.connected"); `message` is the
human line the activity feed shows.
"""
import logging
import os
import threading
import time
from typing import Callable

from core.atomic_io import read_json
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

EVENTS_FILE = None  # a test can point the feed at its own file


def events_file() -> str:
    """The current account's activity feed (Multi-Account group 3)."""
    from core import accounts
    return EVENTS_FILE or accounts.path("events.json")


MAX_EVENTS_KEPT = 300

_lock = threading.RLock()
_subscribers: list[Callable[[dict], None]] = []
# Each feed as this process last read or wrote it; this module is the feed file's only writer. Saves go through
# core/store_writer.py (coalesced, off the event loop): every routine run emits two or three events, and each
# used to re-read and pretty-print the whole feed on the loop (100-bot scale test, 2026-11-10).
_feeds: dict[str, list] = {}


def _feed(path: str) -> list:
    held = _feeds.get(path)
    if held is None:
        loaded = read_json(path, [])
        held = _feeds[path] = loaded if isinstance(loaded, list) else []
    return held


def _snapshot(path: str) -> list:
    with _lock:
        return list(_feeds.get(path, []))


def emit(event_type: str, message: str, level: str = "info", **extra) -> None:
    event = {"ts": time.time(), "type": event_type, "message": message, "level": level, **extra}
    from core import store_writer
    from core.accounts import NoAccount
    try:
        with _lock:
            path = events_file()
            events = _feed(path)
            events.append(event)
            del events[:-MAX_EVENTS_KEPT]
            store_writer.save(path, lambda: _snapshot(path))
    except NoAccount:
        pass  # nobody signed in (a refused sign-in, say): there is no feed it belongs to
    except Exception:
        logger.exception("events: failed to persist %s", event_type)
    for fn in _subscribers:
        try:
            fn(event)
        except Exception:
            logger.exception("events: subscriber failed on %s", event_type)


def subscribe(fn: Callable[[dict], None]) -> None:
    _subscribers.append(fn)


def recent(limit: int = 50) -> list[dict]:
    with _lock:
        events = list(_feed(events_file()))
    return list(reversed(events[-limit:]))
