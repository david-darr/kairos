"""One chat's usage, summed from its recorded runs (Session Usage and Model Tracking, unit 1, 2026-11-07;
spec: the vault note "Session Usage and Model Tracking - Hermes Study (Build Spec)").

The figures behind the context pill's popover: how many turns the chat has had, the tokens they carried
(input, output, cache read and write), the cache-hit share, tool calls, compactions and helpers, and the
last reply's time to first output and speed. Everything comes from the session store's `runs` table
(core/runs.py record), which is per account, so a person only ever reads their own chats' runs.

Unknown is never zero. A sum is None when no run in it reported that figure, and the result says how many
runs did report, so "12,400 output tokens from 3 of 5 turns" is never shown as the whole. A fork is a chat
of its own: it counts only the runs made in it.
"""
from typing import Iterable, Optional

from core import run_cost, runs

TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
SOURCE = "runs"  # every figure here is read from the runs table


def _sum(rows: Iterable[dict], key: str) -> Optional[int]:
    found = [r[key] for r in rows if isinstance(r.get(key), (int, float)) and not isinstance(r.get(key), bool)]
    return int(sum(found)) if found else None


def _reported(rows: list[dict]) -> int:
    """How many of these runs reported any token figure at all."""
    return sum(1 for r in rows if any(r.get(k) is not None for k in TOKEN_FIELDS) or r.get("total_tokens") is not None)


def cache_hit_percent(rows: list[dict]) -> Optional[float]:
    """Cache reads over the whole input, over only the runs that reported both. None when none did, and
    for input with no cache split at all (a provider that does not report one is not a 0% hit rate)."""
    pairs = [(r["cache_read_tokens"], r["input_tokens"]) for r in rows
             if isinstance(r.get("cache_read_tokens"), int) and isinstance(r.get("input_tokens"), int)
             and r["input_tokens"] > 0]
    if not pairs:
        return None
    read, whole = sum(p[0] for p in pairs), sum(p[1] for p in pairs)
    return round(min(read / whole, 1.0) * 100, 1) if whole else None


def ttft_seconds(run: dict) -> Optional[float]:
    """Time from the run's start to its first visible output, or None when either is unknown."""
    first, started = run.get("first_output_at"), run.get("started_at")
    if first is None or started is None or first < started:
        return None
    return round(first - started, 2)


def totals(rows: list[dict]) -> dict:
    """The token sums and counts for a group of runs. Each sum None when no run reported it."""
    return {
        "runs": len(rows),
        "reported_runs": _reported(rows),
        **{key: _sum(rows, key) for key in TOKEN_FIELDS},
        "total_tokens": _sum(rows, "total_tokens"),
        "tool_calls": _sum(rows, "tool_calls") or 0,
        "cache_hit_percent": cache_hit_percent(rows),
        "cost": run_cost.summarize(rows),
        "failed": sum(1 for r in rows if r.get("outcome") == "failed"),
        "stopped": sum(1 for r in rows if r.get("outcome") == "stopped"),
    }


def group(row: dict, chat_run_ids: set) -> str:
    """Which part of the chat's spend a run is: its own turns, its side calls (a compaction, a summary:
    unit 2's `purpose`), its helpers, or other work in it."""
    if row.get("purpose"):
        return "side"
    if row.get("surface") == "chat":
        return "turns"
    if row.get("surface") == "helper" or (row.get("parent_id") and row["parent_id"] in chat_run_ids):
        return "helpers"
    return "other"


def last_reply(rows: list[dict]) -> Optional[dict]:
    """The newest finished turn's speed: time to first output and tok/s, each None when not measurable
    (a reply that arrived in one piece has no rate)."""
    turns = sorted((r for r in rows if r.get("surface") == "chat" and r.get("outcome") == "finished"),
                   key=lambda r: r.get("started_at") or 0)
    if not turns:
        return None
    run = turns[-1]
    return {"run_id": run["id"], "model": run.get("model"), "endpoint_id": run.get("endpoint_id"),
            "ttft_seconds": ttft_seconds(run), "tokens_per_second": runs.tokens_per_second(run),
            "output_tokens": run.get("output_tokens"), "ended_at": run.get("ended_at")}


def compaction_records(rows: list[dict]) -> list[dict]:
    """Each recorded compaction (unit 6 and seamless compaction), oldest first, with when it ended: a summary,
    a no-model prune, or Claude Code compacting its own context. A run whose record does not parse is skipped."""
    import json
    found = []
    for row in rows:
        if row.get("purpose") != "compact" or not row.get("compaction"):
            continue
        try:
            record = json.loads(row["compaction"])
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict):
            found.append({**record, "at": row.get("ended_at") or row.get("started_at")})
    return sorted(found, key=lambda r: r.get("at") or 0)


# Compactions that leave no checkpoint on the chat (each is counted from its run instead).
NO_CHECKPOINT_METHODS = ("prune", "cli")


def summarize(session: dict, rows: list[dict]) -> dict:
    """The chat's usage: `rows` are every run recorded for it (oldest first or any order)."""
    chat_ids = {r["id"] for r in rows if r.get("surface") == "chat"}
    groups = {"turns": [], "side": [], "helpers": [], "other": []}
    for row in rows:
        groups[group(row, chat_ids)].append(row)
    whole = totals(rows)
    records = compaction_records(groups["side"])
    return {
        "session_id": session.get("id"),
        "source": SOURCE,
        "turns": len(groups["turns"]),
        **{k: whole[k] for k in (*TOKEN_FIELDS, "total_tokens", "tool_calls", "cache_hit_percent",
                                  "reported_runs", "failed", "stopped", "cost")},
        "runs": whole["runs"],
        # Summaries the chat keeps, plus prunes that made no model call (unit 6) and Claude Code's own
        # compactions, each recorded on a run.
        "compactions": len(session.get("compactions") or []) + sum(
            1 for r in records if r.get("method") in NO_CHECKPOINT_METHODS),
        # The newest one, for Chat details: the only place a compaction shows (it never interrupts the chat).
        "last_compaction": records[-1] if records else None,
        "helper_runs": len(groups["helpers"]),
        "side_runs": len(groups["side"]),
        "side_purposes": {p: sum(1 for r in groups["side"] if r["purpose"] == p)
                          for p in sorted({r["purpose"] for r in groups["side"]})},
        "parts": {name: totals(items) for name, items in groups.items()},
        "last_reply": last_reply(rows),
        "first_run_at": min((r["started_at"] for r in rows if r.get("started_at")), default=None),
        "last_run_at": max((r.get("ended_at") or r.get("started_at") or 0 for r in rows), default=None) or None,
    }


def for_session(session_id: str, session: dict) -> dict:
    """Read the chat's runs from the store and sum them."""
    from core import session_manager_store as store
    return {**summarize(session, store.session_runs(session_id)), "session_id": session_id}
