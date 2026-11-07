"""Each model's measured speed and reliability, from its real runs (Session Usage and Model Tracking, unit 3,
2026-11-07; spec: the vault note "Session Usage and Model Tracking - Hermes Study (Build Spec)").

Read from the runs table (core/runs.py record), which is per account, over a window of days (7 by default,
up to 90 on request; decision 5): per connection and model, how many runs, median and p90 time to first
output, median output speed, how often runs failed (by error class) or were stopped, tool-call quality and
tokens. Nothing is stored apart from the runs.

Unknown is never zero. A median needs MIN_SAMPLES measured runs, else it is None and `enough_data` says so.
Each provider says what it does not expose: Claude Code and Codex run their own tools (no tool-call quality),
and Codex sends a reply whole (no output rate).
"""
import json
import statistics
import time
from typing import Iterable, Optional

from core import run_cost, runs
from core.session_usage import ttft_seconds

DEFAULT_DAYS = 7
MAX_DAYS = 90
MIN_SAMPLES = 5
ERROR_CLASSES = ("rate_limit", "overload", "overflow", "auth", "network", "other")
TOOL_QUALITY = ("clean", "repaired", "invalid_json", "unknown_tool", "missing_arguments")
# Purposes left out of speed and reliability: a Test ping is not real work.
SKIPPED_PURPOSES = ("model_test",)

# What each kind of connection does not report, said in the stats rather than shown as zero.
NOT_REPORTED = {
    "claude_cli": ["tool-call quality (Claude Code runs its own tools)"],
    "codex_cli": ["output speed (Codex sends each reply whole)", "tool-call quality (Codex runs its own tools)"],
    "antigravity_cli": ["tool-call quality (Antigravity runs its own tools)"],
}


def _median(values: list) -> Optional[float]:
    return round(statistics.median(values), 2) if len(values) >= MIN_SAMPLES else None


def _p90(values: list) -> Optional[float]:
    if len(values) < MIN_SAMPLES:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))], 2)


def _sum(rows: Iterable[dict], key: str) -> Optional[int]:
    found = [r[key] for r in rows if isinstance(r.get(key), int)]
    return sum(found) if found else None


def _tool_quality(rows: list[dict]) -> Optional[dict]:
    counts, seen = {k: 0 for k in TOOL_QUALITY}, False
    for row in rows:
        raw = row.get("tool_quality")
        if not raw:
            continue
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except ValueError:
            continue
        if isinstance(data, dict):
            seen = True
            for key in TOOL_QUALITY:
                counts[key] += int(data.get(key) or 0)
    return counts if seen else None


def summarize(rows: list[dict], kind: Optional[str] = None) -> dict:
    """One group of runs (one model, or one connection) as its stats."""
    ttfts = [t for t in (ttft_seconds(r) for r in rows if r.get("outcome") == "finished") if t is not None]
    rates = [t for t in (runs.tokens_per_second(r) for r in rows if r.get("outcome") == "finished") if t is not None]
    failed = [r for r in rows if r.get("outcome") == "failed"]
    stopped = sum(1 for r in rows if r.get("outcome") == "stopped")
    by_class = {}
    for row in failed:
        name = row.get("error_class") or "other"
        by_class[name] = by_class.get(name, 0) + 1
    count = len(rows)
    retried = [r["retries"] for r in rows if isinstance(r.get("retries"), int)]
    return {
        "runs": count,
        "enough_data": count >= MIN_SAMPLES,
        "finished": sum(1 for r in rows if r.get("outcome") == "finished"),
        "failed": len(failed),
        "stopped": stopped,
        "failure_rate": round(len(failed) / count, 3) if count else None,
        "stop_rate": round(stopped / count, 3) if count else None,
        "failures_by_class": by_class,
        "retries": sum(retried) if retried else None,
        "ttft_samples": len(ttfts),
        "ttft_median_s": _median(ttfts),
        "ttft_p90_s": _p90(ttfts),
        "rate_samples": len(rates),
        "tokens_per_second_median": _median(rates),
        "tool_quality": _tool_quality(rows),
        "input_tokens": _sum(rows, "input_tokens"),
        "output_tokens": _sum(rows, "output_tokens"),
        "cost": run_cost.summarize(rows),
        "last_run_at": max((r.get("started_at") or 0 for r in rows), default=None) or None,
        # Newest first: unit 7's "failed N of its last 10" reads these.
        "recent_outcomes": [r.get("outcome") for r in sorted(rows, key=lambda r: r.get("started_at") or 0, reverse=True)[:10]],
        "not_reported": NOT_REPORTED.get(kind or "", []),
    }


def collect(rows: list[dict], kinds: Optional[dict] = None) -> dict:
    """Group runs by connection and by connection and model."""
    kinds = kinds or {}
    by_endpoint, by_model = {}, {}
    for row in rows:
        if row.get("purpose") in SKIPPED_PURPOSES or not row.get("endpoint_id"):
            continue
        by_endpoint.setdefault(row["endpoint_id"], []).append(row)
        by_model.setdefault((row["endpoint_id"], row.get("model") or None), []).append(row)
    return {
        "endpoints": {eid: {"endpoint_id": eid, "kind": kinds.get(eid), **summarize(items, kinds.get(eid))}
                      for eid, items in by_endpoint.items()},
        "models": [{"endpoint_id": eid, "model": model, "kind": kinds.get(eid), **summarize(items, kinds.get(eid))}
                   for (eid, model), items in sorted(by_model.items(), key=lambda kv: -len(kv[1]))],
    }


def stats(days: int = DEFAULT_DAYS, now: Optional[float] = None) -> dict:
    """The current account's stats over the last `days` days."""
    from core import model_endpoints, session_manager_store as store
    days = max(1, min(int(days), MAX_DAYS))
    since = (now or time.time()) - days * 86400
    kinds = {}
    for endpoint in model_endpoints.list_endpoints():
        kinds[endpoint["id"]] = endpoint.get("kind")
    return {"days": days, "since": since, "min_samples": MIN_SAMPLES, "source": "runs",
            **collect(store.runs_since(since), kinds)}
