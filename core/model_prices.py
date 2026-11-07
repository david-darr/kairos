"""USD per million tokens: the bundled, dated price snapshot. List prices, never subscription billing.

Each row says when its price was taken and from where (SNAPSHOT_META), and a figure priced from it is an
estimate. No network was used to build it; do not claim these are current prices. Exact model ids only, no
fuzzy aliases (core/run_cost.py strips a "provider/" prefix, nothing more).

- 2025-08-07, offline: https://docs.anthropic.com/en/docs/about-claude/pricing and
  https://openai.com/api/pricing/ (the original six rows, used by bot usage).
- 2026-10-06: the Claude API reference's model table (cached 2026-10-06) for input and output, and its stated
  cache-read prices for Claude Opus 5.5, Claude Sonnet 5.5 and Claude Fable 5.1. Other cache prices follow
  Anthropic's standard multipliers (cache read 0.1x input, 5-minute cache write 1.25x input) and say so.
  Claude Haiku 5.5's rows are its prices for prompts up to 100K tokens.

Live prices (an endpoint's own /models, OpenRouter's public list) are kept apart in core/price_feeds.py and
win over this snapshot when present. An operator can replace any entry for bots through Usage and spend.
"""
import math

PRICES_AS_OF = "2025-08-07"  # the original rows' date (bot usage's price list)
SNAPSHOT_SOURCE_2025 = "Bundled snapshot of Anthropic and OpenAI list prices"
SNAPSHOT_SOURCE_2026 = "Bundled snapshot of Claude API list prices"
STANDARD_CACHE = " (cache prices by Anthropic's standard multipliers)"


def _claude(input_rate, output_rate, cache_read=None):
    return dict(input=input_rate, output=output_rate,
                cache_read=cache_read if cache_read is not None else round(input_rate * 0.1, 4),
                cache_write=round(input_rate * 1.25, 4))


LIST_PRICES = {
    "claude-sonnet-4-20250514": dict(input=3.0, output=15.0, cache_read=.30, cache_write=3.75),
    "claude-opus-4-20250514": dict(input=15.0, output=75.0, cache_read=1.50, cache_write=18.75),
    "claude-3-5-haiku-20241022": dict(input=.80, output=4.0, cache_read=.08, cache_write=1.0),
    "gpt-4.1-2025-04-14": dict(input=2.0, output=8.0, cache_read=.50, cache_write=2.0),
    "gpt-4.1-mini-2025-04-14": dict(input=.40, output=1.60, cache_read=.10, cache_write=.40),
    "gpt-4.1-nano-2025-04-14": dict(input=.10, output=.40, cache_read=.025, cache_write=.10),
    # 2026-10-06 rows.
    "claude-fable-5-1": _claude(10.0, 50.0, cache_read=.25),
    "claude-fable-5": _claude(10.0, 50.0),
    "claude-opus-5-5": _claude(4.0, 20.0, cache_read=.20),
    "claude-opus-5": _claude(5.0, 25.0),
    "claude-opus-4-8": _claude(5.0, 25.0),
    "claude-opus-4-7": _claude(5.0, 25.0),
    "claude-opus-4-6": _claude(5.0, 25.0),
    "claude-sonnet-5-5": _claude(2.0, 10.0, cache_read=.20),
    "claude-sonnet-5": _claude(2.0, 10.0),
    "claude-sonnet-4-6": _claude(3.0, 15.0),
    "claude-haiku-5-5": _claude(.10, .50),
    "claude-haiku-4-5": _claude(1.0, 5.0),
}

# model -> (as of, source) for every row above.
SNAPSHOT_META = {model: (PRICES_AS_OF, SNAPSHOT_SOURCE_2025) for model in list(LIST_PRICES)[:6]}
SNAPSHOT_META.update({model: ("2026-10-06", SNAPSHOT_SOURCE_2026 + ("" if model in ("claude-fable-5-1", "claude-opus-5-5",
                                                                                   "claude-sonnet-5-5") else STANDARD_CACHE))
                      for model in list(LIST_PRICES)[6:]})


def number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def cost_of(rates: dict, tokens: dict):
    """USD for one run's tokens at these per-million rates, or None when input or output is unknown.

    Input is the entire prompt, including both cache buckets. Missing cache buckets mean the provider did not
    expose a split: charge the input list price. A rate the source did not give for a cache bucket is charged
    at the input price."""
    if not all(number(tokens.get(k)) for k in ("input", "output")):
        return None
    cached = min(tokens["input"], tokens.get("cache_read") or 0)
    written = min(tokens["input"] - cached, tokens.get("cache_write") or 0)
    uncached = tokens["input"] - cached - written
    read_rate = rates.get("cache_read") if number(rates.get("cache_read")) else rates["input"]
    write_rate = rates.get("cache_write") if number(rates.get("cache_write")) else rates["input"]
    return (uncached * rates["input"] + cached * read_rate + written * write_rate
            + tokens["output"] * rates["output"]) / 1_000_000


def price(model, tokens, reported=None, overrides=None):
    """Unknown input or output means unknown estimate, never a zero bill."""
    if number(reported):
        return {"cost_usd": float(reported), "cost_source": "reported", "priced_as_of": None}
    rates = (overrides or {}).get(model, LIST_PRICES.get(model))
    cost = cost_of(rates, tokens) if rates else None
    if cost is None:
        return {"cost_usd": None, "cost_source": "unknown", "priced_as_of": None}
    return {"cost_usd": cost, "cost_source": "estimated",
            "priced_as_of": "override" if model in (overrides or {}) else SNAPSHOT_META.get(model, (PRICES_AS_OF,))[0]}
