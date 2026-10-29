"""USD per million tokens. Historical list prices, never subscription billing.

Offline reference snapshot, 2025-08-07:
https://docs.anthropic.com/en/docs/about-claude/pricing
https://openai.com/api/pricing/
Network verification was forbidden for this build. Keep this historical date;
do not claim these are current prices. Exact model ids only, no fuzzy aliases.
An operator can replace any entry through Usage and spend.
"""
import math

PRICES_AS_OF = "2025-08-07"
LIST_PRICES = {
    "claude-sonnet-4-20250514": dict(input=3.0, output=15.0, cache_read=.30, cache_write=3.75),
    "claude-opus-4-20250514": dict(input=15.0, output=75.0, cache_read=1.50, cache_write=18.75),
    "claude-3-5-haiku-20241022": dict(input=.80, output=4.0, cache_read=.08, cache_write=1.0),
    "gpt-4.1-2025-04-14": dict(input=2.0, output=8.0, cache_read=.50, cache_write=2.0),
    "gpt-4.1-mini-2025-04-14": dict(input=.40, output=1.60, cache_read=.10, cache_write=.40),
    "gpt-4.1-nano-2025-04-14": dict(input=.10, output=.40, cache_read=.025, cache_write=.10),
}


def number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def price(model, tokens, reported=None, overrides=None):
    """Unknown input or output means unknown estimate, never a zero bill.

    Input is the entire prompt, including both cache buckets. Missing cache
    buckets mean the provider did not expose a split: charge input list price.
    """
    if number(reported):
        return {"cost_usd": float(reported), "cost_source": "reported", "priced_as_of": None}
    rates = (overrides or {}).get(model, LIST_PRICES.get(model))
    if not rates or not all(number(tokens.get(k)) for k in ("input", "output")):
        return {"cost_usd": None, "cost_source": "unknown", "priced_as_of": None}
    cached = min(tokens["input"], tokens.get("cache_read") or 0)
    written = min(tokens["input"] - cached, tokens.get("cache_write") or 0)
    uncached = tokens["input"] - cached - written
    cost = (uncached * rates["input"] + cached * rates["cache_read"]
            + written * rates["cache_write"] + tokens["output"] * rates["output"]) / 1_000_000
    return {"cost_usd": cost, "cost_source": "estimated",
            "priced_as_of": "override" if model in (overrides or {}) else PRICES_AS_OF}
