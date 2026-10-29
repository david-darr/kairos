"""Read-only trace trees over the existing bounded run_events timeline.

No tool details are copied: the old timeline contains arguments and outputs,
so traces deliberately project only a tool name, status and time.
"""
import json
from itertools import groupby

from core import session_manager_store as store
from services import bot_usage


def weight(tokens):
    return (max(0, (tokens.get("input") or 0) - (tokens.get("cache_read") or 0) - (tokens.get("cache_write") or 0))
            + (tokens.get("cache_read") or 0) * .1 + (tokens.get("cache_write") or 0) * 1.25
            + (tokens.get("output") or 0) * 5)


def allocate(spans, cost):
    """Last span absorbs rounding so allocations add to the run's exact cost."""
    weights = [weight(s.get("tokens", {})) for s in spans]
    if not sum(weights):
        weights = [max(0, s.get("duration_s") or 0) for s in spans]
    if not sum(weights):
        weights = [1] * len(spans)
    used, whole = 0, sum(weights)
    for index, (span, value) in enumerate(zip(spans, weights)):
        part = None if cost is None else cost - used if index == len(spans) - 1 else cost * value / whole
        span["cost_usd"] = part
        used += part or 0


def spans(row, timeline):
    result, previous = [], row["at"]
    for index, step in enumerate(timeline):
        kind = step.get("kind")
        if kind not in ("model_call", "tool_finished", "computer"):
            continue
        at = step.get("at", previous)
        duration = max(0, step.get("seconds") or (at - previous if kind == "model_call" else 0))
        item = {"id": f"{row['run_id']}:{index}", "kind": "step" if kind == "model_call" else "tool",
                "name": "Model call" if kind == "model_call" else str(step.get("name") or "Tool")[:80],
                "at": at - duration, "duration_s": duration, "ok": step.get("ok"), "children": []}
        if kind == "model_call":
            try:
                raw = json.loads(step.get("detail") or "{}")
                item["tokens"] = {k: raw.get(k) for k in ("input", "output", "cache_read", "cache_write")}
            except (ValueError, TypeError, AttributeError):
                item["tokens"] = {}
        result.append(item)
        previous = at
    model = [s for s in result if s["kind"] == "step"]
    allocate(model or result, row.get("cost_usd"))
    if len(result) >= 3:
        max(result, key=lambda s: s["duration_s"])["slowest"] = True
        priced = [s for s in result if s.get("cost_usd") is not None]
        if priced:
            max(priced, key=lambda s: s["cost_usd"])["costliest"] = True
    folded = []
    for key, values in groupby(result, lambda s: s["name"] if s["kind"] == "tool" else s["id"]):
        group = list(values)
        if len(group) >= 3:
            folded.append({"id": group[0]["id"] + ":group", "kind": "tool_group", "name": f"{key} ({len(group)})",
                           "at": group[0]["at"], "duration_s": max(s["at"] + s["duration_s"] for s in group) - group[0]["at"],
                           "ok": all(s["ok"] is not False for s in group), "children": group})
        else:
            folded.extend(group)
    return folded


def detail(run_id, user, seen=None, depth=0):
    # Ledger outlives the runs ring. Older traces show totals even if pruned.
    row = next((r for r in bot_usage.rows(user=user) if r["run_id"] == run_id), None)
    if row is None:
        # Detail may be outside the default 30-day window.
        import time
        row = next((r for r in bot_usage.rows(time.time() - 366 * 86400, time.time(), user=user)
                    if r["run_id"] == run_id), None)
    if row is None:
        raise KeyError(run_id)
    seen = set() if seen is None else seen
    if run_id in seen or depth >= 20:
        return None
    seen.add(run_id)
    timeline = store.run_events(run_id)
    children = spans(row, timeline)
    for child in store.find_runs(parent_id=run_id, limit=100):
        try:
            nested = detail(child["id"], user, seen, depth + 1)
            if nested:
                children.append(nested)
        except KeyError:
            pass
    return {**row, "id": run_id, "kind": "run", "name": row.get("model") or "Bot run",
            "children": children, "totals_only": not bool(timeline)}
