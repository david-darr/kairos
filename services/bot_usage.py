"""Bot usage projection and monthly append-only ledger. No message content.

The recorder queues bounded work on one writer, never file I/O on the event
loop. Readers stream lines, ignore torn final rows, deduplicate run ids, and
recheck ownership against the bot and its authoritative session/task.
"""
import asyncio
import copy
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.model_prices import price

log = logging.getLogger(__name__)
ROOT: Optional[Path] = None  # a test can point it at its own folder


def root() -> Path:
    from core import accounts
    return ROOT or Path(accounts.path("bot_usage"))


LOCK = threading.RLock()
_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bot-usage")
_slots = threading.BoundedSemaphore(128)
DEFAULTS = {"budget": {"monthly_usd": None, "warn_percent": 80}, "alerts": {"warned": None, "capped": None},
            "prices_override": {}, "event_retention_days": 30, "event_size_cap_mb": 50}
GROUPS = {"bot", "model", "endpoint", "day", "trigger", "routine"}


def settings(where=None):
    """where: the usage folder, for the writer thread, which has no account of its own."""
    with LOCK:
        raw = read_json(str((where or root()) / "settings.json"), {})
        return {**copy.deepcopy(DEFAULTS), **raw,
                "budget": {**DEFAULTS["budget"], **raw.get("budget", {})},
                "alerts": {**DEFAULTS["alerts"], **raw.get("alerts", {})}}


def update_settings(**changes):
    with LOCK:
        value = {**settings(), **changes}
        write_json_atomic(str(root() / "settings.json"), value)
        os.chmod(root() / "settings.json", 0o600)
        return value


def month(at=None):
    return datetime.fromtimestamp(time.time() if at is None else at, timezone.utc).strftime("%Y-%m")


def bounds(start=None, end=None):
    def parse(value, default):
        if value is None:
            return default
        try:
            if isinstance(value, (int, float)):
                return float(value)
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt.replace(tzinfo=dt.tzinfo or timezone.utc).timestamp()
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Use an ISO date or timestamp") from None
    end = parse(end, time.time())
    start = parse(start, end - 30 * 86400)
    if not (0 <= start <= end and end - start <= 366 * 86400):
        raise ValueError("Choose a range of at most 366 days")
    return start, end


def visible(row, user):
    from services import bot_attention
    from services.agent_service import agent_service
    bot = agent_service.get(row.get("bot_id"))
    if not bot or not bot_attention.owns(bot, user):
        return False
    source = {"session_id": row.get("thread_id"), "task_id": row.get("routine_id")}
    return bot_attention._source_visible(source, user, bot)


def rows(start=None, end=None, bot_id=None, user=None):
    """user=None is trusted internal accounting only; routes always supply it."""
    start, end = bounds(start, end)
    seen = set()
    with LOCK:
        paths = sorted(root().glob("????-??.jsonl"))
        # Hold the writer lock while streaming so no partial append is read.
        for path in paths:
            if not month(start) <= path.stem <= month(end):
                continue
            with path.open(encoding="utf-8") as stream:
                for line in stream:
                    if len(line) > 32768:
                        continue
                    try:
                        row = json.loads(line)
                        ident, at = row["run_id"], row["at"]
                    except (ValueError, KeyError, TypeError):
                        continue
                    if ident in seen or not start <= at < end:
                        continue
                    seen.add(ident)
                    if bot_id and row.get("bot_id") != bot_id:
                        continue
                    if user is not None and not visible(row, user):
                        continue
                    yield row


def _observe(row, timeline, context, where=None):
    try:
        where = where or root()
        if not row.get("agent_id"):
            return
        tokens = {key: row.get(column) for key, column in
                  (("input", "input_tokens"), ("output", "output_tokens"),
                   ("cache_read", "cache_read_tokens"), ("cache_write", "cache_write_tokens"))}
        kind = getattr(context, "actual_model", {}).get("kind", getattr(context, "model_kind", None))
        if not kind and row.get("endpoint_id"):
            from core.model_endpoints import get_endpoint
            kind = (get_endpoint(row["endpoint_id"]) or {}).get("kind")
        value = {"at": row["started_at"], "run_id": row["id"], "bot_id": row["agent_id"],
                 "thread_id": row.get("session_id"), "endpoint_id": row.get("endpoint_id"),
                 "model_kind": kind, "model": row.get("model"), "tokens": tokens,
                 **price(row.get("model"), tokens, getattr(context, "reported_cost_usd", None),
                         settings(where)["prices_override"]),
                 "trigger": getattr(context, "trigger", None) or
                            ("routine" if row.get("task_id") else "helper" if row.get("parent_id") else "person"),
                 "routine_id": row.get("task_id"), "duration_s": max(0, row["ended_at"] - row["started_at"]),
                 "outcome": row["outcome"], "tools": row.get("tool_calls", 0),
                 "steps": sum(s.get("kind") == "model_call" for s in timeline),
                 "tool_errors": sum(s.get("kind") == "tool_finished" and s.get("ok") is False for s in timeline),
                 "parent_id": row.get("parent_id")}
        where.mkdir(parents=True, exist_ok=True)
        with LOCK:
            path = where / (month(value["at"]) + ".jsonl")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        return value
    except Exception:
        log.exception("Could not observe bot usage")


def observe(row, timeline, context):
    """Exception-proof, bounded submission. Sync callers persist immediately."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _observe(row, timeline, context)
    if not row.get("agent_id") or not _slots.acquire(blocking=False):
        return
    try:
        # The writer thread has no account: resolve the folder here, in the caller.
        future = _writer.submit(_observe, dict(row), list(timeline), context, root())
        future.add_done_callback(lambda _: _slots.release())
    except Exception:
        _slots.release()
        log.exception("Could not queue bot usage")


def drain():
    """Shutdown/tests: call off the event loop before the data store closes."""
    _writer.submit(lambda: None).result(timeout=15)


def totals(items):
    result = dict(runs=0, duration_s=0, cost_usd=None, unknown_cost_runs=0,
                  tokens=0, steps=0, tools=0, errors=0)
    known = []
    for row in items:
        result["runs"] += 1
        result["duration_s"] += row.get("duration_s", 0)
        cost = row.get("cost_usd")
        if cost is None:
            result["unknown_cost_runs"] += 1
        else:
            known.append(cost)
        result["tokens"] += sum(row.get("tokens", {}).get(k) or 0 for k in ("input", "output"))
        result["steps"] += row.get("steps", 0)
        result["tools"] += row.get("tools", 0)
        result["errors"] += row.get("tool_errors", 0)
    result["cost_usd"] = sum(known) if known else None
    return result


def summary(start=None, end=None, group_by="bot", bot_id=None, user=None):
    if group_by not in GROUPS:
        raise ValueError("Unknown usage group")
    groups, items = {}, list(rows(start, end, bot_id, user))
    for row in items:
        key = (datetime.fromtimestamp(row["at"], timezone.utc).date().isoformat() if group_by == "day"
               else row.get({"bot": "bot_id", "endpoint": "endpoint_id", "routine": "routine_id"}.get(group_by, group_by)))
        groups.setdefault(key or "Unknown", []).append(row)
    return {"totals": totals(items), "groups": [{"key": key, **totals(value)} for key, value in groups.items()],
            "group_by": group_by, "cost_note": "List-price equivalent, not billed"}


def runs(start=None, end=None, bot_id=None, offset=0, limit=50, user=None):
    if not 0 <= offset <= 1_000_000 or not 1 <= limit <= 100:
        raise ValueError("Invalid page")
    items = sorted(rows(start, end, bot_id, user), key=lambda r: r["at"], reverse=True)
    return {"rows": items[offset:offset + limit], "total": len(items), "offset": offset, "limit": limit}


def csv_export(start=None, end=None, bot_id=None, user=None):
    import csv
    import io
    stream = io.StringIO(newline="")
    columns = ("run_id", "at", "bot_id", "model", "endpoint_id", "trigger", "duration_s", "cost_usd", "cost_source", "outcome")
    writer = csv.writer(stream)
    writer.writerow(columns)
    for row in rows(start, end, bot_id, user):
        def cell(value):
            text = "" if value is None else str(value)
            return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text
        writer.writerow([cell(row.get(k)) for k in columns])
    return stream.getvalue()
