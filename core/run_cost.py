"""What a run cost, priced when it is recorded (Session Usage and Model Tracking, unit 4, 2026-11-07).

Every cost carries a status and a source, after Hermes's CostResult:
- actual: the provider reported the run's cost itself;
- estimated: tokens times a list price, from (in order) the connection's own /models prices, OpenRouter's
  public list, or the bundled dated snapshot (core/model_prices.py); the source says which and when;
- included: a subscription (Claude Code, Codex, Antigravity) or a model on this machine: no per-token bill,
  never shown as $0;
- unknown: no price for the model, or the provider did not report the tokens; never $0.

Priced at record time and stored on the run, so a later price change does not rewrite history.
"""
from typing import Optional

from core import model_prices, price_feeds

SUBSCRIPTION_KINDS = ("claude_cli", "codex_cli", "antigravity_cli")


def _date(seconds: Optional[float]) -> Optional[str]:
    import datetime
    return datetime.date.fromtimestamp(seconds).isoformat() if seconds else None


def _candidates(model: str) -> list[str]:
    """The model id as given, then without an "provider/" prefix (OpenRouter's "anthropic/claude-x")."""
    names = [model]
    if "/" in model:
        names.append(model.split("/", 1)[1])
    return names


def rates_for(model: Optional[str], base_url: Optional[str] = None, feeds: Optional[dict] = None) -> Optional[dict]:
    """{rates, source, as_of} for a model, or None when no source prices it."""
    if not model:
        return None
    feeds = price_feeds.read() if feeds is None else feeds
    own = feeds.get((base_url or "").rstrip("/")) if base_url else None
    if own and model in (own.get("models") or {}):
        return {"rates": own["models"][model], "source": "the connection's own price list",
                "as_of": _date(own.get("fetched_at"))}
    router = feeds.get(price_feeds.OPENROUTER) or {}
    listed = router.get("models") or {}
    for name in [model, *(f"{vendor}/{model}" for vendor in ("anthropic", "openai", "google", "deepseek", "mistralai",
                                                               "x-ai", "qwen", "meta-llama"))]:
        if name in listed:
            return {"rates": listed[name], "source": "OpenRouter's price list", "as_of": _date(router.get("fetched_at"))}
    for name in _candidates(model):
        if name in model_prices.LIST_PRICES:
            as_of, source = model_prices.SNAPSHOT_META[name]
            return {"rates": model_prices.LIST_PRICES[name], "source": source, "as_of": as_of}
    return None


def cost(run: dict, kind: Optional[str], base_url: Optional[str] = None, reported: Optional[float] = None,
         feeds: Optional[dict] = None) -> dict:
    """{cost_usd, cost_status, cost_source, priced_as_of} for one run row."""
    if model_prices.number(reported):
        return {"cost_usd": float(reported), "cost_status": "actual", "cost_source": "reported by the provider",
                "priced_as_of": None}
    if not run.get("endpoint_id") and not run.get("model") and run.get("input_tokens") is None:
        return {"cost_usd": 0.0, "cost_status": "actual", "cost_source": "no model call", "priced_as_of": None}
    if kind in SUBSCRIPTION_KINDS:
        return {"cost_usd": None, "cost_status": "included", "cost_source": "subscription", "priced_as_of": None}
    if kind == "local":
        return {"cost_usd": None, "cost_status": "included", "cost_source": "runs on this machine", "priced_as_of": None}
    found = rates_for(run.get("model"), base_url, feeds)
    tokens = {"input": run.get("input_tokens"), "output": run.get("output_tokens"),
              "cache_read": run.get("cache_read_tokens"), "cache_write": run.get("cache_write_tokens")}
    amount = model_prices.cost_of(found["rates"], tokens) if found else None
    if amount is None:
        return {"cost_usd": None, "cost_status": "unknown",
                "cost_source": "no price for this model" if not found else "tokens not reported", "priced_as_of": None}
    return {"cost_usd": round(amount, 8), "cost_status": "estimated", "cost_source": found["source"],
            "priced_as_of": found["as_of"]}


def for_record(run: dict, context) -> dict:
    """The cost columns for a run being recorded (core/runs.py record). Never raises."""
    try:
        kind, base_url = getattr(context, "model_kind", None), None
        if run.get("endpoint_id"):
            from core import model_endpoints
            endpoint = model_endpoints.get_endpoint(run["endpoint_id"]) or {}
            kind = endpoint.get("kind") or kind
            base_url = endpoint.get("base_url")
        return cost(run, kind, base_url, getattr(context, "reported_cost_usd", None))
    except Exception:
        return {"cost_usd": None, "cost_status": "unknown", "cost_source": "could not be priced", "priced_as_of": None}


def summarize(rows: list[dict]) -> dict:
    """A group's cost: the sum of what is known, and how many runs were included, unknown or unpriced (older
    runs recorded before costs were kept). `total_usd` is None when nothing was priced, never 0."""
    known = [r["cost_usd"] for r in rows if model_prices.number(r.get("cost_usd"))]
    statuses = {}
    for row in rows:
        status = row.get("cost_status") or "not_recorded"
        statuses[status] = statuses.get(status, 0) + 1
    sources = sorted({f"{r['cost_source']}" + (f", {r['priced_as_of']}" if r.get("priced_as_of") else "")
                      for r in rows if r.get("cost_status") in ("estimated", "actual") and r.get("cost_source")})
    return {"total_usd": round(sum(known), 6) if known else None, "statuses": statuses, "sources": sources,
            "complete": bool(rows) and statuses.get("estimated", 0) + statuses.get("actual", 0) == len(rows)}
